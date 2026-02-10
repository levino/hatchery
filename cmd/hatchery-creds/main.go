package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/docker/docker/api/types/events"
	"github.com/docker/docker/api/types/filters"
	"github.com/levinkeller/hatchery/internal/config"
	"github.com/levinkeller/hatchery/internal/creds"
	"github.com/levinkeller/hatchery/internal/drone"
	"github.com/levinkeller/hatchery/internal/zerg"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("loading config: %v", err)
	}
	if err := cfg.RequireCredentials(); err != nil {
		log.Fatalf("missing credentials: %v", err)
	}

	// Ensure socket directory exists
	if err := os.MkdirAll(cfg.SocketDir, 0755); err != nil {
		log.Fatalf("creating socket dir: %v", err)
	}

	tp, err := creds.NewTokenProvider(cfg.GitHubAppID, cfg.GitHubInstallationID, cfg.GitHubAppPrivateKey)
	if err != nil {
		log.Fatalf("creating token provider: %v", err)
	}

	sm := creds.NewSocketManager(cfg.SocketDir, tp)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Recovery: recreate sockets for all existing drones
	if err := recover(ctx, sm); err != nil {
		log.Printf("recovery warning: %v", err)
	}

	// Graceful shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		log.Println("shutting down...")
		sm.Shutdown(ctx)
		cancel()
	}()

	// Watch Docker events
	watchEvents(ctx, sm)
}

// recover queries Docker for existing hatchery drones and creates sockets for them.
func recover(ctx context.Context, sm *creds.SocketManager) error {
	zerg.Printf(zerg.MsgRecovering)

	cli, err := drone.NewClient()
	if err != nil {
		return fmt.Errorf("connecting to Docker: %w", err)
	}
	defer cli.Close()

	drones, err := drone.ListDrones(ctx, cli)
	if err != nil {
		return fmt.Errorf("listing drones: %w", err)
	}

	for _, d := range drones {
		if d.State == "running" {
			repos := reposFromDrone(d)
			if err := sm.CreateSocket(d.Name, repos); err != nil {
				log.Printf("failed to recover socket for %s: %v", d.Name, err)
			}
		}
	}

	return nil
}

// watchEvents subscribes to Docker container events and manages sockets accordingly.
func watchEvents(ctx context.Context, sm *creds.SocketManager) {
	cli, err := drone.NewClient()
	if err != nil {
		log.Fatalf("connecting to Docker for events: %v", err)
	}
	defer cli.Close()

	f := filters.NewArgs()
	f.Add("type", string(events.ContainerEventType))
	f.Add("label", drone.LabelManaged+"=true")

	eventCh, errCh := cli.Events(ctx, events.ListOptions{Filters: f})

	log.Println("watching Docker events...")

	for {
		select {
		case <-ctx.Done():
			return
		case err := <-errCh:
			if err != nil && ctx.Err() == nil {
				log.Printf("Docker event stream error: %v", err)
			}
			return
		case event := <-eventCh:
			droneName := event.Actor.Attributes[drone.LabelDrone]
			if droneName == "" {
				continue
			}

			switch event.Action {
			case events.ActionStart:
				repo := event.Actor.Attributes[drone.LabelRepo]
				repos := parseRepos(repo)
				if err := sm.CreateSocket(droneName, repos); err != nil {
					log.Printf("failed to create socket for %s: %v", droneName, err)
				}
			case events.ActionStop, events.ActionDie:
				sm.RemoveSocket(droneName)
			}
		}
	}
}

// reposFromDrone extracts the repo list from a drone's labels.
func reposFromDrone(d drone.Drone) []string {
	return parseRepos(d.Repo)
}

// parseRepos splits a comma-separated repo string into a slice.
func parseRepos(repo string) []string {
	if repo == "" {
		return nil
	}
	repos := strings.Split(repo, ",")
	for i := range repos {
		repos[i] = strings.TrimSpace(repos[i])
	}
	return repos
}
