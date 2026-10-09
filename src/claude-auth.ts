import { existsSync } from "node:fs";
import { join } from "node:path";
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
