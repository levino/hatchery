import { execSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lookup } from "node:dns/promises";
import Docker from "dockerode";
import {
  findDrone,
  droneName,
  hostname,
  LABEL_MANAGED,
  LABEL_DRONE,
  LABEL_REPO,
} from "./docker.ts";
import type { Config } from "./config.ts";
import { msg } from "./zerg.ts";

export async function spawn(docker: Docker, repo: string, config: Config) {
  const name = droneName(repo);

  // 1. Check for existing drone
  const existing = await findDrone(docker, name);
  if (existing) {
    throw new Error(msg.droneExists);
  }

  // 2. Clone repo to temp dir
  console.log(msg.spawnStarting);
  console.log(msg.cloning);
  const tmpDir = mkdtempSync(join(tmpdir(), "hatchery-clone-"));

  try {
    const repoUrl = `https://github.com/${repo}.git`;
    execSync(`git clone ${repoUrl} ${tmpDir}`, { stdio: "inherit" });

    // 3. devcontainer up with CLI flags (no override config needed)
    devcontainerUp(tmpDir, name, repo, config);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // 4. Wait for Tailscale
  const host = hostname(name, config.tailscaleDomain);
  console.log(msg.waitingTailscale);
  try {
    await waitForHost(host, 120_000);
  } catch {
    console.log(`Warning: Tailscale hostname ${host} not yet resolvable`);
  }

  console.log(msg.spawnComplete);
  console.log(`  ssh -p 2222 node@${host}`);
}

function devcontainerUp(
  workDir: string,
  name: string,
  repo: string,
  config: Config,
) {
  const socketHostPath = join(config.socketDir, `${name}.sock`);
  const devcontainerBin = resolve("node_modules/.bin/devcontainer");

  // Build env vars
  const envArgs: string[] = [];
  const envVars: Record<string, string> = {
    TS_AUTHKEY: config.headscaleAuthKey,
    TS_HOSTNAME: name,
  };

  // Inherit git identity from host
  try {
    const gitName = execSync("git config user.name", {
      encoding: "utf-8",
    }).trim();
    envVars.GIT_AUTHOR_NAME = gitName;
    envVars.GIT_COMMITTER_NAME = gitName;
  } catch {}
  try {
    const gitEmail = execSync("git config user.email", {
      encoding: "utf-8",
    }).trim();
    envVars.GIT_AUTHOR_EMAIL = gitEmail;
    envVars.GIT_COMMITTER_EMAIL = gitEmail;
  } catch {}

  for (const [k, v] of Object.entries(envVars)) {
    envArgs.push("--remote-env", `${k}=${v}`);
  }

  const args = [
    "up",
    "--workspace-folder",
    workDir,
    // Labels to identify hatchery drones
    "--id-label",
    `${LABEL_MANAGED}=true`,
    "--id-label",
    `${LABEL_DRONE}=${name}`,
    "--id-label",
    `${LABEL_REPO}=${repo}`,
    // Mount credential socket (only if creds service is running)
    ...(existsSync(socketHostPath)
      ? [
          "--mount",
          `type=bind,source=${socketHostPath},target=/var/run/github-creds.sock`,
        ]
      : []),
    // Environment variables
    ...envArgs,
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
