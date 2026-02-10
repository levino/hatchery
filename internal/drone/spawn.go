package drone

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"
	"github.com/levinkeller/hatchery/internal/config"
	"github.com/levinkeller/hatchery/internal/zerg"
)

// SpawnOptions configures a new drone.
type SpawnOptions struct {
	Repo   string
	Config *config.Config
}

// Spawn creates a new drone: volume, clone, override config, devcontainer up, wait for tailscale.
func Spawn(ctx context.Context, cli *client.Client, opts SpawnOptions) error {
	name := DroneName(opts.Repo)
	volName := VolumeName(name)

	// 1. Check for existing drone
	existing, err := FindDrone(ctx, cli, name)
	if err != nil {
		return fmt.Errorf("%s %w", zerg.MsgDockerError, err)
	}
	if existing != nil {
		return fmt.Errorf(zerg.MsgDroneExists)
	}

	// 2. Create Docker volume
	zerg.Printf(zerg.MsgSpawnStarting)
	_, err = cli.VolumeCreate(ctx, volume.CreateOptions{
		Name: volName,
	})
	if err != nil {
		return fmt.Errorf("creating volume: %w", err)
	}

	// 3. Clone repo via ephemeral alpine/git container
	zerg.Printf(zerg.MsgCloning)
	if err := cloneRepo(ctx, cli, opts.Repo, volName); err != nil {
		return fmt.Errorf("cloning repo: %w", err)
	}

	// 4. Write override config
	overrideDir, err := writeOverrideConfig(name, opts.Repo, opts.Config)
	if err != nil {
		return fmt.Errorf("writing override config: %w", err)
	}
	defer os.RemoveAll(overrideDir)

	// 5. devcontainer up
	if err := devcontainerUp(ctx, volName, overrideDir); err != nil {
		return fmt.Errorf("devcontainer up: %w", err)
	}

	// 6. Wait for Tailscale hostname
	hostname := Hostname(name, opts.Config.TailscaleDomain)
	zerg.Printf(zerg.MsgWaitingTailscale)
	if err := waitForHost(ctx, hostname, 120*time.Second); err != nil {
		zerg.Printf("Warning: Tailscale hostname %s not yet resolvable: %v", hostname, err)
	}

	zerg.Printf(zerg.MsgSpawnComplete)
	zerg.Printf("  ssh -p 2222 node@%s", hostname)
	return nil
}

// cloneRepo runs an ephemeral alpine/git container to clone into a volume.
func cloneRepo(ctx context.Context, cli *client.Client, repo, volName string) error {
	repoURL := "https://github.com/" + repo + ".git"

	// Pull alpine/git image
	reader, err := cli.ImagePull(ctx, "alpine/git", image.PullOptions{})
	if err != nil {
		return fmt.Errorf("pulling alpine/git: %w", err)
	}
	reader.Close()

	resp, err := cli.ContainerCreate(ctx, &container.Config{
		Image: "alpine/git",
		Cmd:   []string{"clone", repoURL, "/workspace"},
	}, &container.HostConfig{
		Binds: []string{volName + ":/workspace"},
	}, nil, nil, "")
	if err != nil {
		return fmt.Errorf("creating clone container: %w", err)
	}
	defer cli.ContainerRemove(ctx, resp.ID, container.RemoveOptions{Force: true})

	if err := cli.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
		return fmt.Errorf("starting clone container: %w", err)
	}

	waitCh, errCh := cli.ContainerWait(ctx, resp.ID, container.WaitConditionNotRunning)
	select {
	case result := <-waitCh:
		if result.StatusCode != 0 {
			return fmt.Errorf("git clone exited with status %d — %s", result.StatusCode, zerg.MsgRepoNotFound)
		}
	case err := <-errCh:
		return fmt.Errorf("waiting for clone: %w", err)
	}

	return nil
}

// writeOverrideConfig creates a temp dir with a devcontainer override JSON.
func writeOverrideConfig(name, repo string, cfg *config.Config) (string, error) {
	dir, err := os.MkdirTemp("", "hatchery-override-*")
	if err != nil {
		return "", err
	}

	socketHostPath := filepath.Join(cfg.SocketDir, name+".sock")

	containerEnv := map[string]string{
		"TS_AUTHKEY":  cfg.HeadscaleAuthKey,
		"TS_HOSTNAME": name,
	}

	// Inherit git identity from host
	if gitName, err := exec.Command("git", "config", "user.name").Output(); err == nil {
		containerEnv["GIT_AUTHOR_NAME"] = strings.TrimSpace(string(gitName))
		containerEnv["GIT_COMMITTER_NAME"] = strings.TrimSpace(string(gitName))
	}
	if gitEmail, err := exec.Command("git", "config", "user.email").Output(); err == nil {
		containerEnv["GIT_AUTHOR_EMAIL"] = strings.TrimSpace(string(gitEmail))
		containerEnv["GIT_COMMITTER_EMAIL"] = strings.TrimSpace(string(gitEmail))
	}

	override := map[string]any{
		"name": name,
		"features": map[string]any{
			"ghcr.io/devcontainers/features/sshd:1":      map[string]any{},
			"ghcr.io/tailscale/codespace/tailscale": map[string]any{},
		},
		"containerEnv": containerEnv,
		"mounts": []string{
			fmt.Sprintf("source=%s,target=/var/run/github-creds.sock,type=bind", socketHostPath),
		},
		"runArgs": []string{
			"--label", LabelManaged + "=true",
			"--label", LabelDrone + "=" + name,
			"--label", LabelRepo + "=" + repo,
		},
	}

	data, err := json.MarshalIndent(override, "", "  ")
	if err != nil {
		return "", err
	}

	overridePath := filepath.Join(dir, "devcontainer.json")
	if err := os.WriteFile(overridePath, data, 0644); err != nil {
		return "", err
	}

	return dir, nil
}

// devcontainerUp runs `devcontainer up` with the override config.
func devcontainerUp(ctx context.Context, volName, overrideDir string) error {
	cmd := exec.CommandContext(ctx, "devcontainer", "up",
		"--workspace-mount-consistency", "consistent",
		"--mount", fmt.Sprintf("source=%s,target=/workspaces,type=volume", volName),
		"--workspace-folder", "/workspaces",
		"--override-config", filepath.Join(overrideDir, "devcontainer.json"),
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// waitForHost polls DNS until the hostname resolves or the timeout expires.
func waitForHost(ctx context.Context, hostname string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		_, err := net.LookupHost(hostname)
		if err == nil {
			return nil
		}
		time.Sleep(2 * time.Second)
	}
	return fmt.Errorf("timeout waiting for %s to resolve", hostname)
}
