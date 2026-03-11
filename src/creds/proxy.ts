import { createServer, request as httpRequest, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { unlinkSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ForgejoHost } from "../config.ts";
import { msg } from "../zerg.ts";

interface ProxyEntry {
  server: Server;
  repos: string[];
  fakeToken: string;
  forgejoHost: ForgejoHost;
}

export class ProxyManager {
  private socketDir: string;
  private proxies = new Map<string, ProxyEntry>();

  constructor(socketDir: string) {
    this.socketDir = socketDir;
  }

  createProxy(droneName: string, repos: string[], forgejoHost: ForgejoHost, fakeToken?: string): string {
    if (this.proxies.has(droneName)) {
      return this.proxies.get(droneName)!.fakeToken;
    }

    const token = fakeToken ?? `hatchery:${droneName}:${randomBytes(16).toString("hex")}`;

    const droneDir = join(this.socketDir, droneName);
    mkdirSync(droneDir, { recursive: true });
    const socketPath = join(droneDir, "proxy.sock");

    try { unlinkSync(socketPath); } catch {}

    const server = createServer((req, res) => {
      this.handleRequest(droneName, req, res);
    });

    server.listen(socketPath, () => {
      chmodSync(socketPath, 0o666);
      console.log(`${msg.proxyCreated} [${droneName}]`);
    });

    this.proxies.set(droneName, { server, repos, fakeToken: token, forgejoHost });
    return token;
  }

  updateProxy(droneName: string, repos: string[]): void {
    const entry = this.proxies.get(droneName);
    if (entry) {
      entry.repos = repos;
    }
  }

  removeProxy(droneName: string): void {
    const entry = this.proxies.get(droneName);
    if (!entry) return;

    entry.server.close();
    this.proxies.delete(droneName);

    const socketPath = join(this.socketDir, droneName, "proxy.sock");
    try { unlinkSync(socketPath); } catch {}

    console.log(`${msg.proxyRemoved} [${droneName}]`);
  }

  getFakeToken(droneName: string): string | null {
    return this.proxies.get(droneName)?.fakeToken ?? null;
  }

  shutdown(): void {
    for (const [name] of this.proxies) {
      this.removeProxy(name);
    }
  }

  private handleRequest(droneName: string, req: IncomingMessage, res: ServerResponse): void {
    const entry = this.proxies.get(droneName);
    if (!entry) {
      res.writeHead(502);
      res.end("Proxy not found");
      return;
    }

    // Validate fake token from Authorization header
    const authHeader = req.headers.authorization ?? "";

    if (!authHeader) {
      // No auth → 401 so git triggers the credential helper
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Hatchery Forgejo Proxy"' });
      res.end("Authentication required");
      return;
    }

    const providedToken = authHeader.replace(/^(token|basic|bearer)\s+/i, "").trim();

    // For Basic auth, the token is base64-encoded "username:password" — extract password
    let token = providedToken;
    if (authHeader.toLowerCase().startsWith("basic ")) {
      try {
        const decoded = Buffer.from(providedToken, "base64").toString();
        token = decoded.split(":").slice(1).join(":");
      } catch {}
    }

    if (token !== entry.fakeToken) {
      res.writeHead(403);
      res.end("Invalid credentials");
      return;
    }

    // Extract repo from URL path
    const repo = extractRepo(req.url ?? "");
    if (!repo) {
      // Allow non-repo requests (e.g., API user info) to pass through
      this.forwardRequest(entry, req, res);
      return;
    }

    // Check repo is allowed
    if (!entry.repos.includes(repo)) {
      res.writeHead(403);
      res.end(`Access denied to repo ${repo}`);
      return;
    }

    this.forwardRequest(entry, req, res);
  }

  private forwardRequest(entry: ProxyEntry, req: IncomingMessage, res: ServerResponse): void {
    const targetUrl = new URL(entry.forgejoHost.url);
    const isHttps = targetUrl.protocol === "https:";
    const doRequest = isHttps ? httpsRequest : httpRequest;

    const headers = { ...req.headers };
    // Replace auth with real PAT
    headers.authorization = `token ${entry.forgejoHost.token}`;
    // Set correct host
    headers.host = targetUrl.host;

    const opts = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: req.url,
      method: req.method,
      headers,
    };

    const proxyReq = doRequest(opts, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
      console.error(`Proxy error [${targetUrl.hostname}]:`, err.message);
      res.writeHead(502);
      res.end("Proxy error");
    });

    req.pipe(proxyReq);
  }
}

/** Extract org/repo from a request URL path. */
function extractRepo(url: string): string | null {
  const path = url.split("?")[0];

  // Git smart HTTP: /<org>/<repo>.git/info/refs, /<org>/<repo>.git/git-upload-pack, etc.
  const gitMatch = path.match(/^\/([^/]+\/[^/]+?)(?:\.git)?\/(?:info\/|git-|HEAD|objects\/)/);
  if (gitMatch) return gitMatch[1];

  // Forgejo API: /api/v1/repos/<org>/<repo>/...
  const apiMatch = path.match(/^\/api\/v1\/repos\/([^/]+\/[^/]+)/);
  if (apiMatch) return apiMatch[1];

  // Direct repo access: /<org>/<repo>.git (clone URL itself during initial handshake)
  const directMatch = path.match(/^\/([^/]+\/[^/]+?)\.git\/?$/);
  if (directMatch) return directMatch[1];

  return null;
}
