import { createServer, type Server } from "node:http";
import { unlinkSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TokenProvider } from "./token.ts";
import { msg } from "../zerg.ts";

interface SocketEntry {
  server: Server;
  repos: string[];
}

export class SocketManager {
  private socketDir: string;
  private tokenProvider: TokenProvider;
  private sockets = new Map<string, SocketEntry>();

  constructor(socketDir: string, tokenProvider: TokenProvider) {
    this.socketDir = socketDir;
    this.tokenProvider = tokenProvider;
  }

  createSocket(droneName: string, repos: string[]): void {
    if (this.sockets.has(droneName)) return;

    const droneDir = join(this.socketDir, droneName);
    mkdirSync(droneDir, { recursive: true });
    const socketPath = join(droneDir, "creds.sock");

    // Remove stale socket
    try {
      unlinkSync(socketPath);
    } catch {}

    const server = createServer(async (req, res) => {
      if (req.url === "/token") {
        try {
          const token = await this.tokenProvider.getToken(repos);
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(token);
        } catch (err) {
          res.writeHead(500);
          res.end(String(err));
        }
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    server.listen(socketPath, () => {
      chmodSync(socketPath, 0o666);
      console.log(`${msg.socketCreated} [${droneName}]`);
    });

    this.sockets.set(droneName, { server, repos });
  }

  removeSocket(droneName: string): void {
    const entry = this.sockets.get(droneName);
    if (!entry) return;

    entry.server.close();
    this.sockets.delete(droneName);

    const socketPath = join(this.socketDir, droneName, "creds.sock");
    try {
      unlinkSync(socketPath);
    } catch {}

    console.log(`${msg.socketRemoved} [${droneName}]`);
  }

  shutdown(): void {
    for (const [name] of this.sockets) {
      this.removeSocket(name);
    }
  }
}
