import { execFileSync, spawn as spawnChild } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { lookup } from "node:dns/promises";
import Docker from "dockerode";
import {
  findDrone,
  droneName,
  LABEL_MANAGED,
  LABEL_DRONE,
  LABEL_REPO,
} from "./docker.ts";
import type { Config } from "./config.ts";
import { TokenProvider } from "./creds/token.ts";
import { SocketManager } from "./creds/server.ts";
import { msg } from "./zerg.ts";

const HATCHERY_DIR = join(homedir(), ".hatchery", "repos");

/** Known locations for devcontainer.json, checked in order. */
const DEVCONTAINER_CONFIG_PATHS = [
  ".devcontainer/devcontainer.json",
  ".devcontainer.json",
  "devcontainer.json",
];

/**
 * Find the devcontainer.json config file inside a repo directory.
 * Returns the absolute path or null if not found.
 */
function findDevcontainerConfig(repoDir: string): string | null {
  for (const relPath of DEVCONTAINER_CONFIG_PATHS) {
    const fullPath = join(repoDir, relPath);
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }
  return null;
}

export async function spawn(docker: Docker, repo: string, config: Config) {
  // Detect local path vs GitHub org/repo
  const localPath = resolve(repo);
  const isLocal = existsSync(localPath);
  const name = isLocal ? `hatchery-${basename(localPath)}` : droneName(repo);

  const existing = await findDrone(docker, name);
  if (existing) {
    throw new Error(msg.droneExists);
  }

  console.log(msg.spawnStarting);

  // Directory layout for worktree support:
  //   ~/.hatchery/repos/<drone-name>/          <- workspace dir (mounted into container)
  //   ~/.hatchery/repos/<drone-name>/repo/     <- actual git clone
  //   ~/.hatchery/repos/<drone-name>/branch/   <- git worktrees (created inside container)
  const workspaceDir = join(HATCHERY_DIR, name);
  const repoDir = join(workspaceDir, "repo");
  if (!existsSync(repoDir)) {
    console.log(msg.cloning);
    mkdirSync(workspaceDir, { recursive: true });
    const cloneSource = isLocal ? localPath : `https://github.com/${repo}.git`;
    execFileSync("git", ["clone", cloneSource, repoDir], { stdio: "inherit" });
  }

  // Create credential socket before container start so it can be mounted
  let socketManager: SocketManager | null = null;
  if (config.githubAppPrivateKey && !isLocal) {
    mkdirSync(config.socketDir, { recursive: true });
    const tp = new TokenProvider(config);
    socketManager = new SocketManager(config.socketDir, tp);
    socketManager.createSocket(name, [repo]);
    // Wait briefly for socket to be ready
    await new Promise((r) => setTimeout(r, 500));
  }

  // Locate devcontainer.json inside the clone
  const devcontainerConfig = findDevcontainerConfig(repoDir);
  if (!devcontainerConfig) {
    throw new Error(
      `No devcontainer.json found in ${repoDir} — checked ${DEVCONTAINER_CONFIG_PATHS.join(", ")}`,
    );
  }

  // devcontainer up (async — returns when container is running)
  await devcontainerUp(docker, workspaceDir, devcontainerConfig, name, repo, config);

  // Run lifecycle commands (postCreateCommand, postStartCommand, etc.)
  runUserCommands(workspaceDir, devcontainerConfig, name, config);

  // Set up container: SSH keys + git/gh credentials
  const drone = await findDrone(docker, name);
  if (drone) {
    const container = docker.getContainer(drone.id);

    // Inject SSH keys from GitHub
    if (config.githubUser) {
      const sshSetup = await container.exec({
        Cmd: ["sh", "-c", `USER_HOME=$(getent passwd 1000 | cut -d: -f6) && mkdir -p $USER_HOME/.ssh && chmod 700 $USER_HOME/.ssh && curl -fsSL https://github.com/${config.githubUser}.keys >> $USER_HOME/.ssh/authorized_keys && chmod 600 $USER_HOME/.ssh/authorized_keys && chown -R 1000:1000 $USER_HOME/.ssh`],
      });
      await sshSetup.start({});
    }

    // Set up git credential helper and gh wrapper if socket is mounted
    if (socketManager) {
      const credsSetup = await container.exec({
        Cmd: ["sh", "-c", [
          // Git credential helper
          `printf '#!/bin/sh\\ncase "$1" in get) T=$(curl -sf --unix-socket /var/run/github-creds.sock http://localhost/token); [ -z "$T" ] && exit 1; echo "protocol=https"; echo "host=github.com"; echo "username=x-access-token"; echo "password=$T";; esac\\n' > /usr/local/bin/git-credential-hatchery`,
          `chmod +x /usr/local/bin/git-credential-hatchery`,
          `git config --system credential.helper /usr/local/bin/git-credential-hatchery`,
          // gh wrapper: copy real gh, replace with wrapper
          `which gh >/dev/null 2>&1 && cp $(which gh) /usr/bin/gh-real && printf '#!/bin/sh\\nexport GH_TOKEN=$(curl -s --unix-socket /var/run/github-creds.sock http://localhost/token)\\nexec /usr/bin/gh-real "$@"\\n' > /usr/local/bin/gh && chmod +x /usr/local/bin/gh || true`,
        ].join(" && ")],
      });
      await credsSetup.start({});
    }
  }

  // Wait for Tailscale
  console.log(msg.waitingTailscale);
  try {
    await waitForHost(name, 120_000);
  } catch {
    console.log(`Warning: Tailscale hostname ${name} not yet resolvable`);
  }

  const vscodeUri = `vscode://vscode-remote/ssh-remote+${name}/workspaces/${name}`;
  const link = `\x1b]8;;${vscodeUri}\x1b\\${vscodeUri}\x1b]8;;\x1b\\`;
  console.log(msg.spawnComplete);
  console.log(`  ssh vscode@${name}`);
  console.log(`  ${link}`);
}

async function devcontainerUp(
  docker: Docker,
  workspaceDir: string,
  configPath: string,
  name: string,
  repo: string,
  config: Config,
): Promise<void> {
  const socketHostPath = join(config.socketDir, `${name}.sock`);
  const devcontainerBin = resolve("node_modules/.bin/devcontainer");

  const args = [
    "up",
    "--workspace-folder",
    workspaceDir,
    "--config",
    configPath,
    "--mount-workspace-git-root",
    "false",
    "--id-label",
    `${LABEL_MANAGED}=true`,
    "--id-label",
    `${LABEL_DRONE}=${name}`,
    "--id-label",
    `${LABEL_REPO}=${repo}`,
    ...(existsSync(socketHostPath)
      ? [
          "--mount",
          `type=bind,source=${socketHostPath},target=/var/run/github-creds.sock`,
        ]
      : []),
  ];

  // devcontainer up hangs after the container starts, so run it detached
  // and poll docker for the container to appear
  const child = spawnChild(devcontainerBin, args, {
    env: hatcheryEnv(name, config),
    stdio: "inherit",
    detached: true,
  });
  child.unref();

  // Poll until the container is running
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const drone = await findDrone(docker, name);
    if (drone && drone.state === "running") {
      // Container is up, kill the hanging devcontainer process
      try { process.kill(-child.pid!, "SIGTERM"); } catch {}
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  try { process.kill(-child.pid!, "SIGTERM"); } catch {}
  throw new Error("Timeout waiting for container to start");
}

function runUserCommands(
  workspaceDir: string,
  configPath: string,
  name: string,
  config: Config,
) {
  const devcontainerBin = resolve("node_modules/.bin/devcontainer");

  const args = [
    "run-user-commands",
    "--workspace-folder",
    workspaceDir,
    "--config",
    configPath,
    "--id-label",
    `${LABEL_MANAGED}=true`,
    "--id-label",
    `${LABEL_DRONE}=${name}`,
  ];

  execFileSync(devcontainerBin, args, { stdio: "inherit", env: hatcheryEnv(name, config) });
}

function hatcheryEnv(name: string, config: Config) {
  return {
    ...process.env,
    HATCHERY_TS_AUTH_KEY: config.headscaleAuthKey,
    HATCHERY_TS_HOSTNAME: name,
    HATCHERY_TS_LOGIN_SERVER: `https://${config.tailscaleDomain}`,
  };
}

async function waitForHost(
  host: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await lookup(host);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`Timeout waiting for ${host} to resolve`);
}
