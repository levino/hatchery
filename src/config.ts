import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import dotenv from "dotenv";

export interface Config {
  githubClientId: string;
  githubAppPrivateKey: string;
  githubUser: string;
  installations: Record<string, string>; // org -> installation ID
  headscaleAuthKey: string;
  tailscaleDomain: string;
  socketDir: string;
}

export function loadConfig(): Config {
  dotenv.config();
  if (existsSync("/etc/hatchery.env")) {
    dotenv.config({ path: "/etc/hatchery.env" });
  }

  let privateKey = process.env.HATCHERY_GITHUB_APP_KEY ?? "";
  if (privateKey && !privateKey.startsWith("-----")) {
    const keyPath = resolve(privateKey);
    if (existsSync(keyPath)) {
      privateKey = readFileSync(keyPath, "utf-8");
    }
  }

  const installations: Record<string, string> = {};
  if (existsSync("config.json")) {
    const raw = JSON.parse(readFileSync("config.json", "utf-8"));
    Object.assign(installations, raw.installations ?? {});
  }

  return {
    githubClientId: process.env.HATCHERY_GITHUB_CLIENT_ID ?? "",
    githubAppPrivateKey: privateKey,
    githubUser: process.env.HATCHERY_GITHUB_USER ?? "",
    installations,
    headscaleAuthKey: process.env.HATCHERY_HEADSCALE_AUTH_KEY ?? "",
    tailscaleDomain:
      process.env.HATCHERY_TAILSCALE_DOMAIN ?? "tail.levinkeller.de",
    socketDir: process.env.HATCHERY_SOCKET_DIR ?? join(homedir(), ".hatchery", "sockets"),
  };
}

export function installationId(
  config: Config,
  repo: string,
): string {
  const org = repo.split("/")[0];
  const id = config.installations[org];
  if (!id) {
    throw new Error(
      `No GitHub App installation configured for org "${org}" — add it to config.json`,
    );
  }
  return id;
}

export function requireCredentials(config: Config): void {
  if (!config.githubClientId) {
    throw new Error("HATCHERY_GITHUB_CLIENT_ID not set");
  }
  if (!config.githubAppPrivateKey) {
    throw new Error("HATCHERY_GITHUB_APP_KEY not set");
  }
  if (Object.keys(config.installations).length === 0) {
    throw new Error(
      "No installations configured — add them to config.json",
    );
  }
}
