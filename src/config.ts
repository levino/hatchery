import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";

export interface Config {
  githubClientId: string;
  githubAppPrivateKey: string;
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
    installations,
    headscaleAuthKey: process.env.HATCHERY_HEADSCALE_AUTH_KEY ?? "",
    tailscaleDomain:
      process.env.HATCHERY_TAILSCALE_DOMAIN ?? "tail.levinkeller.de",
    socketDir: process.env.HATCHERY_SOCKET_DIR ?? "/var/run/hatchery",
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
