import { execFileSync, spawn as spawnChild } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import Docker from "dockerode";
import {
  findDrone,
  droneName,
  forgejoFroneName,
  writeRepoInfo,
  ensureRestartPolicy,
  LABEL_MANAGED,
  LABEL_DRONE,
  LABEL_REPO,
} from "./docker.ts";
import type { Config } from "./config.ts";
import { msg, HatcheryError } from "./zerg.ts";
import { randomBytes } from "node:crypto";

const HATCHERY_DIR = join(homedir(), ".hatchery", "repos");

/**
 * Copy a local feature directory into the repo's .devcontainer/ folder
 * so the devcontainer CLI can reference it as "./hatchery".
 * Returns a cleanup function to remove the copy afterwards.
 */
function installLocalFeature(featureDir: string, repoDir: string): () => void {
  const destDir = join(repoDir, ".devcontainer", "hatchery");
  execFileSync("rm", ["-rf", destDir]);
  mkdirSync(join(repoDir, ".devcontainer"), { recursive: true });
  execFileSync("cp", ["-r", resolve(featureDir), destDir]);
  return () => { try { execFileSync("rm", ["-rf", destDir]); } catch {} };
}

/** Known locations for devcontainer.json, checked in order. */
const DEVCONTAINER_CONFIG_PATHS = [
  ".devcontainer/devcontainer.json",
  ".devcontainer.json",
  "devcontainer.json",
];

/**
 * Parse a repo argument into its components.
 * - "org/repo" → GitHub
 * - "forgejo.example.com/org/repo" → Forgejo
 * - "/absolute/path" → local
 */
export interface ParsedRepo {
  provider: "github" | "forgejo" | "local";
  host?: string;       // only for forgejo
  repo: string;        // org/repo
  name: string;        // drone name
  forgejoHost?: ForgejoHost;
}

export function parseRepoArg(repoArg: string, config: Config): ParsedRepo {
  const localPath = resolve(repoArg);
  if (existsSync(localPath)) {
    return {
      provider: "local",
      repo: repoArg,
      name: `hatchery-${basename(localPath)}`,
    };
  }

  const parts = repoArg.split("/");
  if (parts.length === 3) {
    // host/org/repo
    const [host, org, repo] = parts;
    const forgejoHost = config.forgejo[host];
    if (!forgejoHost) {
      throw new HatcheryError(`No Forgejo host configured for "${host}" — add it to config.json`);
    }
    return {
      provider: "forgejo",
      host,
      repo: `${org}/${repo}`,
      name: forgejoFroneName(host, `${org}/${repo}`),
      forgejoHost,
    };
  }

  // Default: GitHub (org/repo)
  return {
    provider: "github",
    repo: repoArg,
    name: droneName(repoArg),
  };
}

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
 * Falls back to "root".
 */
function getRemoteUser(configPath: string): string {
  try {
    const raw = readFileSync(configPath, "utf-8");
    const stripped = raw.replace(/^\s*\/\/.*$/gm, "");
    const parsed = JSON.parse(stripped);
    if (parsed.remoteUser) return parsed.remoteUser;
  } catch {}
  return "root";
}

export async function spawn(docker: Docker, repoArg: string, config: Config, extraRepos: string[] = [], tsHostname?: string) {
  const parsed = parseRepoArg(repoArg, config);
  const name = parsed.name;

  const existing = await findDrone(docker, name);
  if (existing) {
    throw new HatcheryError(msg.droneExists);
  }

  // Ensure per-drone sockets dir exists for bind mount
  const droneSocketDir = join(config.socketDir, name);
  mkdirSync(droneSocketDir, { recursive: true });

  // Ensure global SSH host key exists (shared across all drones)
  const hatcheryDir = join(homedir(), ".hatchery");
  const globalHostKey = join(hatcheryDir, "drone_ssh_host_key");
  if (!existsSync(globalHostKey)) {
    execFileSync("ssh-keygen", ["-t", "ed25519", "-f", globalHostKey, "-N", "", "-C", "hatchery-drone-host-key"]);
  }

  console.log(msg.spawnStarting);

  const workspaceDir = join(HATCHERY_DIR, name, "worktrees");
  const repoDir = join(workspaceDir, "main");

  // Clone
  if (!existsSync(repoDir)) {
    console.log(msg.cloning);
    mkdirSync(workspaceDir, { recursive: true });
    let cloneSource: string;
    if (parsed.provider === "local") {
      cloneSource = resolve(repoArg);
    } else if (parsed.provider === "forgejo") {
      // Clone via HTTPS with real PAT on the host (trusted)
      // Use env vars so the token doesn't persist in .git/config
      const fh = parsed.forgejoHost!;
      cloneSource = `${fh.url}/${parsed.repo}.git`;
      execFileSync("git", ["clone", cloneSource, repoDir], {
        stdio: "inherit",
        env: {
          ...process.env,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `http.${fh.url}/.extraheader`,
          GIT_CONFIG_VALUE_0: `Authorization: token ${fh.token}`,
        },
      });
    } else {
      cloneSource = `git@github.com:${parsed.repo}.git`;
    }
    if (parsed.provider !== "forgejo") {
      execFileSync("git", ["clone", cloneSource, repoDir], { stdio: "inherit" });
    }
  } else {
    console.log(msg.updating);
    try {
      if (parsed.provider === "forgejo") {
        const fh = parsed.forgejoHost!;
        execFileSync("git", ["pull", "--ff-only"], {
          cwd: repoDir,
          stdio: "inherit",
          env: {
            ...process.env,
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: `http.${fh.url}/.extraheader`,
            GIT_CONFIG_VALUE_0: `Authorization: token ${fh.token}`,
          },
        });
      } else {
        execFileSync("git", ["pull", "--ff-only"], { cwd: repoDir, stdio: "inherit" });
      }
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
    const loginServer = config.tailscaleDomain.startsWith("http")
      ? config.tailscaleDomain
      : `https://${config.tailscaleDomain}`;
    remoteEnvs.push(["HATCHERY_TS_LOGIN_SERVER", loginServer]);
  }
  remoteEnvs.push(["HATCHERY_TS_HOSTNAME", (tsHostname ?? name).replace(/\./g, "-")]);
  remoteEnvs.push(["CLAUDE_CONFIG_DIR", "/workspaces/worktrees/.claude"]);

  // Forgejo-specific: write repo info so creds-service creates the proxy on container start
  if (parsed.provider === "forgejo") {
    const fakeToken = `hatchery:${name}:${randomBytes(16).toString("hex")}`;
    writeRepoInfo(config.socketDir, name, {
      provider: "forgejo",
      host: parsed.host!,
      repos: [parsed.repo, ...extraRepos],
      fakeToken,
    });
    remoteEnvs.push(["HATCHERY_PROVIDER", "forgejo"]);
    remoteEnvs.push(["HATCHERY_FORGEJO_HOST", parsed.host!]);
    remoteEnvs.push(["HATCHERY_FORGEJO_FAKE_TOKEN", fakeToken]);
  }

  // Write CLAUDE.md to persistent worktrees mount so Claude Code finds it in every drone
  const claudeConfigDir = join(workspaceDir, ".claude");
  mkdirSync(claudeConfigDir, { recursive: true });
  const claudeMdPath = join(claudeConfigDir, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) {
    const org = parsed.provider === "github" ? parsed.repo.split("/")[0] : null;
    const orgLine = org ? `Default org for this drone: \`${org}\`.\n` : "";
    writeFileSync(claudeMdPath, `# Hatchery Drone — Credential System\n\n## GitHub credentials — how it works\n\nYou are inside a Hatchery drone. GitHub access works via a Unix socket at \`/var/run/hatchery-sockets/creds.sock\`. Credentials are automatic — you do NOT need to log in or set tokens manually.\n\n## git (clone, push, pull)\n\nJust works. The credential helper fetches the right token automatically. Do nothing.\n\n## gh CLI\n\nThe \`gh\` wrapper at \`/usr/local/bin/gh\` fetches a token automatically based on the target org. Use it normally:\n\n\`\`\`sh\ngh pr list --repo org/repo\ngh api repos/org/repo\n\`\`\`\n\n${orgLine}The wrapper detects the org from \`--repo\`/\`-R\` or from \`git remote origin\` in the current directory.\n\n## If gh returns no output or fails silently\n\nThe wrapper may be broken. Fetch the token manually:\n\n\`\`\`sh\nTOKEN=\\$(curl -s --unix-socket /var/run/hatchery-sockets/creds.sock "http://localhost/token?org=<org>")\ncurl -s -H "Authorization: token \\$TOKEN" https://api.github.com/repos/org/repo\n\`\`\`\n\nOr call the real binary directly:\n\`\`\`sh\nGH_TOKEN=\\$(curl -s --unix-socket /var/run/hatchery-sockets/creds.sock "http://localhost/token?org=<org>") /usr/bin/gh-real <command>\n\`\`\`\n\n## NEVER do these\n\n- \`gh auth login\`\n- \`export GH_TOKEN=...\` with a hardcoded value\n- Storing tokens anywhere\n\n## 403 "Resource not accessible by integration"\n\nThe GitHub App lacks permission for this operation (e.g. creating repos). Tell the user — do not work around it.\n`);
  }

  const allRepos = parsed.provider === "forgejo"
    ? `${parsed.host}/${parsed.repo}`
    : [parsed.repo, ...extraRepos].join(",");
  await devcontainerUp(docker, repoDir, workspaceDir, devcontainerConfig, name, allRepos, config, remoteEnvs, globalHostKey);

  // Run lifecycle commands (postCreateCommand, postStartCommand, dotfiles, etc.)
  // If the project's updateContentCommand fails, devcontainer skips postStartCommand entirely,
  // so hatchery-post-start (Tailscale join, SSH keys) never runs. We catch that failure and
  // run hatchery-post-start directly so infrastructure setup always completes.
  try {
    runUserCommands(repoDir, devcontainerConfig, name, remoteEnvs, config);
  } catch {
    console.log("Warning: run-user-commands failed — running hatchery-post-start directly");
    await runPostStart(docker, name, remoteEnvs);
  }

  const user = getRemoteUser(devcontainerConfig);
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
  globalHostKey: string,
): Promise<void> {
  const devcontainerBin = resolve("node_modules/.bin/devcontainer");

  const localFeatureDir = process.env.HATCHERY_LOCAL_FEATURE;
  let localFeatureCleanup: (() => void) | undefined;
  let hatcheryFeatureRef = "ghcr.io/levino/hatchery/hatchery:1";
  if (localFeatureDir) {
    localFeatureCleanup = installLocalFeature(localFeatureDir, repoDir);
    hatcheryFeatureRef = "./.devcontainer/hatchery";
    console.log(`Using local feature: ${localFeatureDir}`);
  }

  const additionalFeatures = JSON.stringify({
    "ghcr.io/devcontainers/features/github-cli:1": {},
    "ghcr.io/devcontainers/features/sshd:1": {},
    "ghcr.io/tailscale/codespace/tailscale": {},
    [hatcheryFeatureRef]: {},
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
    "--mount",
    `type=bind,source=${globalHostKey},target=/var/run/hatchery-host-key`,
  ];

  const childEnv = { ...process.env };
  for (const [k, v] of remoteEnvs) {
    childEnv[k] = v;
  }

  const child = spawnChild(devcontainerBin, args, {
    stdio: "inherit",
    detached: true,
    env: childEnv,
  });
  child.unref();

  // Poll until the container is running
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const drone = await findDrone(docker, name);
    if (drone && drone.state === "running") {
      await ensureRestartPolicy(docker, drone.id);
      try { process.kill(-child.pid!, "SIGTERM"); } catch {}
      localFeatureCleanup?.();
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  try { process.kill(-child.pid!, "SIGTERM"); } catch {}
  localFeatureCleanup?.();
  throw new HatcheryError(msg.spawnTimeout);
}

async function runPostStart(
  docker: Docker,
  name: string,
  remoteEnvs: [string, string][],
): Promise<void> {
  const drone = await findDrone(docker, name);
  if (!drone) return;
  const envArgs = remoteEnvs.flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  try {
    execFileSync("docker", ["exec", ...envArgs, drone.id, "/usr/local/bin/hatchery-post-start"], {
      stdio: "inherit",
    });
  } catch {
    console.log("Warning: hatchery-post-start failed");
  }
}

function runUserCommands(
  repoDir: string,
  configPath: string,
  name: string,
  remoteEnvs: [string, string][],
  config: Config,
) {
  const devcontainerBin = resolve("node_modules/.bin/devcontainer");

  const args = [
    "run-user-commands",
    "--workspace-folder",
    repoDir,
    "--config",
    configPath,
    ...remoteEnvs.flatMap(([k, v]) => ["--remote-env", `${k}=${v}`]),
    "--id-label",
    `${LABEL_MANAGED}=true`,
    "--id-label",
    `${LABEL_DRONE}=${name}`,
    ...(config.dotfilesRepo
      ? ["--dotfiles-repository", `https://github.com/${config.dotfilesRepo}`]
      : []),
  ];

  execFileSync(devcontainerBin, args, { stdio: "inherit" });
}
