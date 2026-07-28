import type Docker from "dockerode";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listDrones } from "./docker.ts";

/** Mirrors HATCHERY_DIR in spawn.ts — where per-drone worktrees live. */
export const reposDir = join(homedir(), ".hatchery", "repos");

/**
 * Resolved without loadConfig() on purpose: gc must run from any cwd (the disk
 * watchdog calls it from cron), and loadConfig() reads a relative config.json
 * and throws when HATCHERY_HEADSCALE_AUTH_KEY is absent.
 */
export function defaultSocketDir(): string {
  return process.env.HATCHERY_SOCKET_DIR || join(homedir(), ".hatchery", "sockets");
}

export interface Orphan {
  name: string;
  paths: string[];
  worktrees: number;
  dirty: string[];
  unpushed: string[];
}

/** Has uncommitted changes or commits that exist on no remote. */
export function hasWork(o: Orphan): boolean {
  return o.dirty.length > 0 || o.unpushed.length > 0;
}

function dirsIn(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((n) => !n.startsWith("_") && !n.startsWith("."))
    .filter((n) => {
      try {
        return statSync(join(path, n)).isDirectory();
      } catch {
        return false;
      }
    });
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function inspectWorktrees(droneDir: string): Pick<Orphan, "worktrees" | "dirty" | "unpushed"> {
  const root = join(droneDir, "worktrees");
  const result = { worktrees: 0, dirty: [] as string[], unpushed: [] as string[] };

  for (const branch of dirsIn(root)) {
    const wt = join(root, branch);
    if (!existsSync(join(wt, ".git"))) continue;
    result.worktrees++;
    try {
      if (git(wt, ["status", "--porcelain"]) !== "") result.dirty.push(branch);
      // Commits reachable from a local branch but from no remote — these would
      // be unrecoverable after deletion.
      if (git(wt, ["log", "--oneline", "--branches", "--not", "--remotes"]) !== "") {
        result.unpushed.push(branch);
      }
    } catch {
      // Unreadable or half-deleted worktree: treat as inspectable-but-empty
      // rather than aborting the whole sweep.
    }
  }
  return result;
}

/**
 * Host state whose drone container no longer exists.
 *
 * slay() removes the container and its volumes but never the worktrees, so
 * these directories accumulate indefinitely — they were ~120G of the disk
 * exhaustion on 2026-07-27.
 */
export async function listOrphans(docker: Docker, socketDir: string): Promise<Orphan[]> {
  const live = new Set((await listDrones(docker)).map((d) => d.name));

  const names = new Set([...dirsIn(reposDir), ...dirsIn(socketDir)]);
  const orphans: Orphan[] = [];

  for (const name of [...names].sort()) {
    if (live.has(name)) continue;
    const droneDir = join(reposDir, name);
    const paths = [droneDir, join(socketDir, name)].filter((p) => existsSync(p));
    orphans.push({ name, paths, ...inspectWorktrees(droneDir) });
  }
  return orphans;
}

/**
 * Devcontainers write as root and as arbitrary container UIDs, so a plain
 * unlink hits EPERM on files the invoking user does not own. Passwordless
 * sudo is the documented setup on the hive; fall back to it before giving up.
 */
export function removePath(path: string): { ok: boolean; error?: string } {
  try {
    rmSync(path, { recursive: true, force: true });
    if (!existsSync(path)) return { ok: true };
  } catch {
    // fall through to sudo
  }
  try {
    execFileSync("sudo", ["-n", "rm", "-rf", "--", path], { stdio: "ignore" });
    if (!existsSync(path)) return { ok: true };
    return { ok: false, error: "still present after sudo rm" };
  } catch {
    return { ok: false, error: `needs manual removal: sudo rm -rf ${path}` };
  }
}
