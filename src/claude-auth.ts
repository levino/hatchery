import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Docker from "dockerode";
import { execInDrone } from "./docker.ts";
import { reposDir } from "./gc.ts";

/**
 * Where a full `/login` inside a drone ends up on the host. Drones set
 * CLAUDE_CONFIG_DIR=/workspaces/worktrees/.claude, which is bind-mounted from
 * ~/.hatchery/repos/<drone>/worktrees/.claude — so Claude Code's Linux
 * credentials file lands there, persistently, readable from inside the drone.
 */
export function accountLoginPath(drone: string, base: string = reposDir): string {
  return join(base, drone, "worktrees", ".claude", ".credentials.json");
}

/**
 * True if the drone holds a full-scope account login (connectors, profile,
 * refresh token) instead of — or besides — the inference-only token that
 * connect-claude provides.
 */
export function hasAccountLogin(drone: string, base: string = reposDir): boolean {
  return existsSync(accountLoginPath(drone, base));
}

/**
 * How a drone authenticates Claude Code:
 * - "token" (default): inference-only `claude setup-token` token via connect-claude.
 * - "login": the user's full account via `/login` — connectors, profile, refresh
 *   token, persisted in the bind-mounted CLAUDE_CONFIG_DIR. Opt-in per drone.
 */
export type ClaudeAuthMode = "token" | "login";

export function parseClaudeAuthMode(value: string): ClaudeAuthMode {
  if (value === "token" || value === "login") return value;
  throw new Error(`Unknown Claude auth mode '${value}' (expected token or login)`);
}

/** Next to `<drone>.repos.json`, outside the bind-mounted socket dir, so the
 *  drone cannot pick its own mode. */
export function claudeAuthFilePath(socketDir: string, drone: string): string {
  return join(socketDir, `${drone}.claude-auth`);
}

export function readClaudeAuthMode(socketDir: string, drone: string): ClaudeAuthMode {
  try {
    return parseClaudeAuthMode(readFileSync(claudeAuthFilePath(socketDir, drone), "utf-8").trim());
  } catch {
    return "token";
  }
}

/** The default needs no file; only "login" is written down. */
export function writeClaudeAuthMode(socketDir: string, drone: string, mode: ClaudeAuthMode): void {
  const path = claudeAuthFilePath(socketDir, drone);
  if (mode === "token") rmSync(path, { force: true });
  else writeFileSync(path, `${mode}\n`);
}

/**
 * Root shell script that switches a running drone's mode. The feature's env
 * script and connect-claude read /etc/hatchery-claude-auth; the managed setting
 * that keeps connectors off only makes sense with the inference-only token.
 * Container files survive restarts but not a rebuild, so spawn re-applies.
 */
export function applyClaudeAuthScript(mode: ClaudeAuthMode): string {
  const managed = "/etc/claude-code/managed-settings.d/50-hatchery.json";
  if (mode === "login") {
    return [
      "printf 'login\\n' > /etc/hatchery-claude-auth",
      `rm -f ${managed}`,
      // A stored token would override the login in every new shell.
      "rm -rf /dev/shm/hatchery-claude-*",
    ].join(" && ");
  }
  return [
    "rm -f /etc/hatchery-claude-auth",
    "mkdir -p /etc/claude-code/managed-settings.d",
    `echo '{ "disableClaudeAiConnectors": true }' > ${managed}`,
  ].join(" && ");
}

const TOKEN_SECTION =
  "## Claude auth\n\nThis drone talks to the model with an inference-only token (`CLAUDE_CODE_OAUTH_TOKEN`, set up with `connect-claude`). NEVER run `/login` or ask the user to approve a Claude login link — that would give the drone the user's whole account. If the token is missing, tell the user to run `connect-claude` in the drone.\n";

const LOGIN_SECTION =
  "## Claude auth\n\nThis drone is logged in with the user's Claude account (`/login`, configured with `hatchery claude-auth <drone> login`). If Claude Code reports it is not logged in, tell the user to run `/login` in the drone. `connect-claude` is disabled here.\n";

export function claudeAuthSection(mode: ClaudeAuthMode): string {
  return mode === "login" ? LOGIN_SECTION : TOKEN_SECTION;
}

/** Swap the "## Claude auth" section of a drone's CLAUDE.md (appended if missing). */
export function withClaudeAuthSection(claudeMd: string, mode: ClaudeAuthMode): string {
  const start = claudeMd.indexOf("## Claude auth\n");
  if (start === -1) return `${claudeMd.replace(/\n*$/, "\n\n")}${claudeAuthSection(mode)}`;
  const next = claudeMd.indexOf("\n## ", start + 1);
  const rest = next === -1 ? "" : claudeMd.slice(next + 1);
  return `${claudeMd.slice(0, start)}${claudeAuthSection(mode)}${rest ? `\n${rest}` : ""}`;
}

export function claudeMdPath(drone: string, base: string = reposDir): string {
  return join(base, drone, "worktrees", ".claude", "CLAUDE.md");
}

/**
 * Bring a drone in line with its stored mode: CLAUDE.md on the host, and the
 * container files when it is running. Returns false if the container could
 * not be updated (stopped, or the exec failed) — unburrow/spawn retry.
 */
export async function applyClaudeAuth(
  docker: Docker,
  drone: { name: string; id: string; state: string },
  mode: ClaudeAuthMode,
  base: string = reposDir,
): Promise<boolean> {
  const md = claudeMdPath(drone.name, base);
  if (existsSync(md)) writeFileSync(md, withClaudeAuthSection(readFileSync(md, "utf-8"), mode));
  if (drone.state !== "running") return false;
  const { exitCode, output } = await execInDrone(docker, drone.id, ["sh", "-c", applyClaudeAuthScript(mode)]);
  if (exitCode !== 0) console.error(`Claude auth not applied in ${drone.name}: ${output.trim()}`);
  return exitCode === 0;
}
