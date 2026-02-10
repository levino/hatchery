import jwt from "jsonwebtoken";
import type { Config } from "../config.ts";
import { installationId } from "../config.ts";

interface CachedToken {
  token: string;
  expiresAt: Date;
}

export class TokenProvider {
  private config: Config;
  private cache = new Map<string, CachedToken>();

  constructor(config: Config) {
    this.config = config;
  }

  async getToken(repos: string[]): Promise<string> {
    const key = cacheKey(repos);

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt.getTime() - Date.now() > 5 * 60 * 1000) {
      return cached.token;
    }

    const instId = installationId(this.config, repos[0]);
    const { token, expiresAt } = await this.createInstallationToken(
      instId,
      repos,
    );

    this.cache.set(key, { token, expiresAt });
    return token;
  }

  private createJWT(): string {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign(
      {
        iat: now - 60,
        exp: now + 10 * 60,
        iss: this.config.githubClientId,
      },
      this.config.githubAppPrivateKey,
      { algorithm: "RS256" },
    );
  }

  private async createInstallationToken(
    instId: string,
    repos: string[],
  ): Promise<{ token: string; expiresAt: Date }> {
    const jwtToken = this.createJWT();

    const resp = await fetch(
      `https://api.github.com/app/installations/${instId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwtToken}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          repositories: repos.map((r) => r.split("/")[1]),
        }),
      },
    );

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`GitHub API returned ${resp.status}: ${body}`);
    }

    const data = (await resp.json()) as {
      token: string;
      expires_at: string;
    };
    return { token: data.token, expiresAt: new Date(data.expires_at) };
  }
}

function cacheKey(repos: string[]): string {
  return [...repos].sort().join(",");
}
