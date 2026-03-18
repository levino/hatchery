import Docker from "dockerode";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const LABEL_MANAGED = "hatchery.managed";
const LABEL_DRONE = "hatchery.drone";
const LABEL_REPO = "hatchery.repo";

export { LABEL_MANAGED, LABEL_DRONE, LABEL_REPO };

export interface Drone {
  name: string;
  repo: string;
  id: string;
  state: string;
}

export interface RepoInfo {
  provider: "github" | "forgejo";
  host?: string;       // forgejo hostname, absent for github
  repos: string[];
  fakeToken?: string;  // only for forgejo
}

export function droneName(repo: string): string {
  return `hatchery-${repo.replace("/", "-")}`;
}

/** Build drone name for forgejo repos: hatchery-<host>-<org>-<repo> */
export function forgejoFroneName(host: string, repo: string): string {
  const shortHost = host.replace(/\./g, "-");
  return `hatchery-${shortHost}-${repo.replace("/", "-")}`;
}

export function hostname(name: string, domain: string): string {
  return `${name}.${domain}`;
}

export function createClient(): Docker {
  return new Docker();
}

export async function listDrones(docker: Docker): Promise<Drone[]> {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: [`${LABEL_MANAGED}=true`] },
  });

  return containers.map((c) => ({
    name: c.Labels[LABEL_DRONE],
    repo: c.Labels[LABEL_REPO],
    id: c.Id,
    state: c.State,
  }));
}

export async function findDrone(
  docker: Docker,
  name: string,
): Promise<Drone | null> {
  const containers = await docker.listContainers({
    all: true,
    filters: {
      label: [`${LABEL_MANAGED}=true`, `${LABEL_DRONE}=${name}`],
    },
  });

  if (containers.length === 0) return null;

  const c = containers[0];
  return {
    name: c.Labels[LABEL_DRONE],
    repo: c.Labels[LABEL_REPO],
    id: c.Id,
    state: c.State,
  };
}

export async function stopDrone(
  docker: Docker,
  id: string,
): Promise<void> {
  await docker.getContainer(id).stop();
}

export async function startDrone(
  docker: Docker,
  id: string,
): Promise<void> {
  await docker.getContainer(id).start();
}

export async function removeDrone(
  docker: Docker,
  id: string,
): Promise<void> {
  const container = docker.getContainer(id);
  const info = await container.inspect();
  const volumes = (info.Mounts ?? [])
    .filter((m: { Type: string; Name?: string }) => m.Type === "volume" && m.Name)
    .map((m: { Name: string }) => m.Name);
  await container.remove({ force: true });
  for (const vol of volumes) {
    try {
      await docker.getVolume(vol).remove();
    } catch {}
  }
}

export function reposFilePath(socketDir: string, droneName: string): string {
  return join(socketDir, droneName, "repos.json");
}

/** Read repos.json — handles both old array format and new RepoInfo object. */
export function readRepoInfo(socketDir: string, droneName: string): RepoInfo | null {
  try {
    const data = readFileSync(reposFilePath(socketDir, droneName), "utf-8");
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) {
      return { provider: "github", repos: parsed };
    }
    return parsed as RepoInfo;
  } catch {
    return null;
  }
}

/** Backward-compatible: returns just the repos array. */
export function readRepos(socketDir: string, droneName: string): string[] | null {
  const info = readRepoInfo(socketDir, droneName);
  return info ? info.repos : null;
}

export function writeRepoInfo(socketDir: string, droneName: string, info: RepoInfo): void {
  const dir = join(socketDir, droneName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(reposFilePath(socketDir, droneName), JSON.stringify(info));
}

/** Backward-compatible: writes a GitHub-style repos array. */
export function writeRepos(socketDir: string, droneName: string, repos: string[]): void {
  writeRepoInfo(socketDir, droneName, { provider: "github", repos });
}
