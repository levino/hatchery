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

export function droneName(repo: string): string {
  return `hatchery-${repo.replace("/", "-")}`;
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
  await docker.getContainer(id).remove({ force: true });
}

export function reposFilePath(socketDir: string, droneName: string): string {
  return join(socketDir, droneName, "repos.json");
}

export function readRepos(socketDir: string, droneName: string): string[] | null {
  try {
    const data = readFileSync(reposFilePath(socketDir, droneName), "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function writeRepos(socketDir: string, droneName: string, repos: string[]): void {
  const dir = join(socketDir, droneName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(reposFilePath(socketDir, droneName), JSON.stringify(repos));
}
