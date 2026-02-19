import { execFileSync, spawn as spawnChild } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import Docker from "dockerode";
import {
  findDrone,
  droneName,
  LABEL_MANAGED,
  LABEL_DRONE,
  LABEL_REPO,
} from "./docker.ts";
import type { Config } from "./config.ts";
import { msg, HatcheryError } from "./zerg.ts";

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

/**
 * Read the remoteUser from a devcontainer.json file.
 * Falls back to container image default user via Docker inspect.
 */
function getRemoteUser(configPath: string, docker: Docker, droneName: string): string {
  try {
    const raw = readFileSync(configPath, "utf-8");
    // Strip JSON-with-comments (line comments only, good enough)
    const stripped = raw.replace(/^\s*\/\/.*$/gm, "");
    const parsed = JSON.parse(stripped);
    if (parsed.remoteUser) return parsed.remoteUser;
  } catch {}
  return "root";
}

export async function spawn(docker: Docker, repo: string, config: Config) {
  // Detect local path vs GitHub org/repo
  const localPath = resolve(repo);
  const isLocal = existsSync(localPath);
  const name = isLocal ? `hatchery-${basename(localPath)}` : droneName(repo);

  const existing = await findDrone(docker, name);
  if (existing) {
    throw new HatcheryError(msg.droneExists);
  }

  // Ensure per-drone sockets dir exists for bind mount
  const droneSocketDir = join(config.socketDir, name);
  mkdirSync(droneSocketDir, { recursive: true });

  console.log(msg.spawnStarting);

  // Directory layout for worktree support:
  //   ~/.hatchery/repos/<drone-name>/
  //   ├── worktrees/           <- mounted via --mount → /workspaces/worktrees/
  //   │   ├── main/            <- git clone, used as --workspace-folder
  //   │   ├── feature-x/       <- git worktree
  //   │   └── bugfix/          <- git worktree
  const workspaceDir = join(HATCHERY_DIR, name, "worktrees");
  const repoDir = join(workspaceDir, "main");
  if (!existsSync(repoDir)) {
    console.log(msg.cloning);
    mkdirSync(workspaceDir, { recursive: true });
    const cloneSource = isLocal ? localPath : `git@github.com:${repo}.git`;
    execFileSync("git", ["clone", cloneSource, repoDir], { stdio: "inherit" });
  } else {
    console.log(msg.updating);
    try {
      execFileSync("git", ["pull", "--ff-only"], { cwd: repoDir, stdio: "inherit" });
    } catch {
      console.log(msg.updateFailed);
    }
  }

  // Locate devcontainer.json inside the clone
  const devcontainerConfig = findDevcontainerConfig(repoDir);
  if (!devcontainerConfig) {
    throw new HatcheryError(msg.noEvolutionPlan);
  }

  // Remote env vars for hatchery feature postStartCommand
  const remoteEnvs: [string, string][] = [];
  if (config.githubUser) {
    remoteEnvs.push(["HATCHERY_GITHUB_USER", config.githubUser]);
  }
  if (config.headscaleAuthKey) {
    remoteEnvs.push(["HATCHERY_TS_AUTH_KEY", config.headscaleAuthKey]);
  }
  if (config.tailscaleDomain) {
    remoteEnvs.push(["HATCHERY_TS_LOGIN_SERVER", `https://${config.tailscaleDomain}`]);
  }
  remoteEnvs.push(["HATCHERY_TS_HOSTNAME", name]);
  remoteEnvs.push(["CLAUDE_CONFIG_DIR", "/workspaces/worktrees/.claude"]);

  // devcontainer up (async — returns when container is running)
  await devcontainerUp(docker, repoDir, workspaceDir, devcontainerConfig, name, repo, config, remoteEnvs);

  // Run lifecycle commands (postCreateCommand, postStartCommand, etc.)
  runUserCommands(repoDir, devcontainerConfig, name, remoteEnvs);

  const user = getRemoteUser(devcontainerConfig, docker, name);
  const vscodeUri = `vscode://vscode-remote/ssh-remote+${name}/workspaces/worktrees/main`;
  const link = `\x1b]8;;${vscodeUri}\x1b\\${vscodeUri}\x1b]8;;\x1b\\`;
  console.log(msg.spawnComplete);
  console.log(`  ssh ${user}@${name}`);
  console.log(`  ${link}`);
}

async function devcontainerUp(
  docker: Docker,
  repoDir: string,
  worktreesDir: string,
  configPath: string,
  name: string,
  repo: string,
  config: Config,
  remoteEnvs: [string, string][],
): Promise<void> {
  const devcontainerBin = resolve("node_modules/.bin/devcontainer");

  const additionalFeatures = JSON.stringify({
    "ghcr.io/devcontainers/features/github-cli:1": {},
    "ghcr.io/devcontainers/features/sshd:1": {},
    "ghcr.io/tailscale/codespace/tailscale": {},
    "ghcr.io/levino/hatchery/hatchery:1": {},
  });

  const args = [
    "up",
    "--workspace-folder",
    repoDir,
    "--config",
    configPath,
    "--mount-workspace-git-root",
    "false",
    "--additional-features",
    additionalFeatures,
    ...remoteEnvs.flatMap(([k, v]) => ["--remote-env", `${k}=${v}`]),
    "--id-label",
    `${LABEL_MANAGED}=true`,
    "--id-label",
    `${LABEL_DRONE}=${name}`,
    "--id-label",
    `${LABEL_REPO}=${repo}`,
    "--mount",
    `type=bind,source=${worktreesDir},target=/workspaces/worktrees`,
    "--mount",
    `type=bind,source=${join(config.socketDir, name)},target=/var/run/hatchery-sockets`,
    ...(config.dotfilesRepo
      ? ["--dotfiles-repository", `https://github.com/${config.dotfilesRepo}`]
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
  throw new HatcheryError(msg.spawnTimeout);
}

function runUserCommands(
  workspaceDir: string,
  configPath: string,
  name: string,
  remoteEnvs: [string, string][],
) {
  const devcontainerBin = resolve("node_modules/.bin/devcontainer");

  const args = [
    "run-user-commands",
    "--workspace-folder",
    workspaceDir,
    "--config",
    configPath,
    ...remoteEnvs.flatMap(([k, v]) => ["--remote-env", `${k}=${v}`]),
    "--id-label",
    `${LABEL_MANAGED}=true`,
    "--id-label",
    `${LABEL_DRONE}=${name}`,
  ];

  execFileSync(devcontainerBin, args, { stdio: "inherit" });
}

