import { execFileSync, spawn as spawnChild } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
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

  // Clone repo to persistent directory
  const repoDir = join(HATCHERY_DIR, name);
  if (!existsSync(repoDir)) {
    console.log(msg.cloning);
    mkdirSync(HATCHERY_DIR, { recursive: true });
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

  // devcontainer up (async — returns when container is running)
  await devcontainerUp(docker, repoDir, name, repo, config);

  // Run lifecycle commands (postCreateCommand, postStartCommand, etc.)
  runUserCommands(repoDir, name);

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
  workDir: string,
  name: string,
  repo: string,
  config: Config,
): Promise<void> {
  const socketHostPath = join(config.socketDir, `${name}.sock`);
  const devcontainerBin = resolve("node_modules/.bin/devcontainer");

  const additionalFeatures = JSON.stringify({
    "ghcr.io/devcontainers/features/sshd:1": {},
    "ghcr.io/tailscale/codespace/tailscale": {},
  });

  const args = [
    "up",
    "--workspace-folder",
    workDir,
    "--additional-features",
    additionalFeatures,
    "--id-label",
    `${LABEL_MANAGED}=true`,
    "--id-label",
    `${LABEL_DRONE}=${name}`,
    "--id-label",
    `${LABEL_REPO}=${repo}`,
    "--remote-env",
    `HATCHERY_TS_AUTH_KEY=${config.headscaleAuthKey}`,
    "--remote-env",
    `HATCHERY_TS_HOSTNAME=${name}`,
    "--remote-env",
    `HATCHERY_TS_LOGIN_SERVER=https://${config.tailscaleDomain}`,
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
  workDir: string,
  name: string,
) {
  const devcontainerBin = resolve("node_modules/.bin/devcontainer");

  const args = [
    "run-user-commands",
    "--workspace-folder",
    workDir,
    "--id-label",
    `${LABEL_MANAGED}=true`,
    "--id-label",
    `${LABEL_DRONE}=${name}`,
  ];

  execFileSync(devcontainerBin, args, { stdio: "inherit" });
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
