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
  /** Provider of the drone's own workspace repo. Decides which credential
   *  mechanism the drone gets for `repos`. */
  provider: "github" | "forgejo";
  host?: string;       // forgejo hostname, absent for github
  repos: string[];
  fakeToken?: string;  // only for forgejo
  /** Additional GitHub repos, independent of `provider`. A Forgejo drone with
   *  entries here gets a GitHub token socket *alongside* its Forgejo proxy —
   *  the two credential paths do not collide, because git routes by URL: the
   *  helper for https://github.com hits creds.sock, the insteadOf rewrites send
   *  Forgejo URLs to the proxy on localhost:9998. Both are already installed in
   *  every drone; before this field the socket simply never existed and the
   *  helper failed with "could not read Username". */
  github?: string[];
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
  await ensureRestartPolicy(docker, id);
  await docker.getContainer(id).start();
}

/** Without this, drones don't come back after the host reboots. */
export async function ensureRestartPolicy(
  docker: Docker,
  id: string,
): Promise<void> {
  await docker.getContainer(id).update({
    RestartPolicy: { Name: "unless-stopped" },
  });
}

/** Run a command in a running container and return exit code + output. */
export async function execInDrone(
  docker: Docker,
  id: string,
  cmd: string[],
): Promise<{ exitCode: number; output: string }> {
  const container = docker.getContainer(id);
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  const info = await exec.inspect();
  return {
    exitCode: info.ExitCode ?? -1,
    output: Buffer.concat(chunks).toString("utf-8"),
  };
}

/** Where the drone reaches its Forgejo proxy. git inside the drone rewrites
 *  every Forgejo URL to this port (insteadOf rules in the container's --system
 *  gitconfig); socat forwards the port to proxy.sock.
 *
 *  Keep in sync with features/hatchery/install.sh, which starts the same
 *  bridge from the post-start script. */
export const FORGEJO_BRIDGE_PORT = 9998;
const DRONE_PROXY_SOCKET = "/var/run/hatchery-sockets/proxy.sock";

/** `pgrep -f` also matches the shell carrying the pattern, so bracket the
 *  first digit: "[9]998" matches "9998" but not itself. Without this the
 *  guard below always reports a running bridge. */
function selfExcludingPort(port: number): string {
  const s = String(port);
  return `[${s[0]}]${s.slice(1)}`;
}

/** Start a drone's Forgejo bridge unless it is already running.
 *
 *  The post-start script starts the bridge too, but postStartCommand only
 *  runs on `devcontainer up` — *not* when the Docker daemon restarts a
 *  container by its restart policy after the host reboots. The insteadOf
 *  rewrites live in the container filesystem and do survive that, so a
 *  rebooted Forgejo drone kept rewriting every clone/fetch onto a port with
 *  nothing behind it ("connection refused", looking exactly like the proxy
 *  being down). Called wherever the proxy socket is created, so the bridge
 *  comes back together with the drone.
 *
 *  Returns true when this call actually started a bridge. */
export async function ensureForgejoBridge(
  docker: Docker,
  droneName: string,
): Promise<boolean> {
  const drone = await findDrone(docker, droneName);
  if (!drone || drone.state !== "running") return false;

  const pattern = `socat.*TCP-LISTEN:${selfExcludingPort(FORGEJO_BRIDGE_PORT)}`;
  const { exitCode } = await execInDrone(docker, drone.id, [
    "sh",
    "-c",
    `pgrep -f "${pattern}" >/dev/null 2>&1`,
  ]);
  if (exitCode === 0) return false;

  // socat is the exec command itself, with no wrapping shell -- the exact
  // shape of `docker exec -d`. Two things that look equivalent are not:
  // backgrounding from a shell (`sh -c "socat ... &"`) loses the process when
  // the shell exits and Docker tears the exec down, and redirecting to the
  // post-start script's log (`> /tmp/hatchery-bridge.log`) fails with
  // EACCES -- exec runs as root but the drone has no CAP_DAC_OVERRIDE, and
  // that file belongs to the remote user. Nothing is attached, so socat's
  // output is discarded; `hatchery-creds` logs the revival instead.
  const exec = await docker.getContainer(drone.id).exec({
    Cmd: [
      "socat",
      `TCP-LISTEN:${FORGEJO_BRIDGE_PORT},bind=127.0.0.1,reuseaddr,fork`,
      `UNIX-CONNECT:${DRONE_PROXY_SOCKET}`,
    ],
    AttachStdout: false,
    AttachStderr: false,
  });
  await exec.start({ Detach: true });
  return true;
}

export async function removeDrone(
  docker: Docker,
  id: string,
): Promise<void> {
  const container = docker.getContainer(id);
  const info = await container.inspect();
  const volumes = (info.Mounts ?? [])
    .filter((m: { Type: string; Name?: string; Destination?: string }) =>
      m.Type === "volume" && m.Name && !m.Name.startsWith("ssh-host-keys-"))
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
