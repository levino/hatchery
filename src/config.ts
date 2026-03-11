import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import dotenv from "dotenv";

export interface ForgejoHost {
  url: string;
  token: string;
  user: string;
}

export interface Config {
  githubClientId: string;
  githubAppPrivateKey: string;
  githubUser: string;
  installations: Record<string, string>; // org -> installation ID
  headscaleAuthKey: string;
  tailscaleDomain: string;
  socketDir: string;
  dotfilesRepo: string;
  forgejo: Record<string, ForgejoHost>; // hostname -> config
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} not set — add it to .env`);
  }
  return value;
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
  const forgejo: Record<string, ForgejoHost> = {};

  if (existsSync("config.json")) {
    const raw = JSON.parse(readFileSync("config.json", "utf-8"));
    Object.assign(installations, raw.installations ?? {});
    if (raw.forgejo) {
      for (const [host, cfg] of Object.entries(raw.forgejo)) {
        forgejo[host] = cfg as ForgejoHost;
      }
    }
  }

  const hasGitHub = Object.keys(installations).length > 0;
  const hasForgejo = Object.keys(forgejo).length > 0;
  if (!hasGitHub && !hasForgejo) {
    throw new Error("No installations or forgejo hosts configured — add them to config.json");
  }

  return {
    githubClientId: process.env.HATCHERY_GITHUB_CLIENT_ID ?? "",
    githubAppPrivateKey: privateKey,
    githubUser: process.env.HATCHERY_GITHUB_USER ?? "",
    installations,
    headscaleAuthKey: requireEnv("HATCHERY_HEADSCALE_AUTH_KEY"),
    tailscaleDomain: requireEnv("HATCHERY_TAILSCALE_DOMAIN"),
    socketDir: process.env.HATCHERY_SOCKET_DIR || join(homedir(), ".hatchery", "sockets"),
    dotfilesRepo: process.env.HATCHERY_DOTFILES_REPO || "",
    forgejo,
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
