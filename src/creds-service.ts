#!/usr/bin/env -S node --experimental-strip-types

import { createServer } from "node:http";
import { mkdirSync, unlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import Docker from "dockerode";
import { loadConfig } from "./config.ts";
import { LABEL_MANAGED, LABEL_DRONE, LABEL_REPO, listDrones, readRepoInfo, writeRepoInfo, writeRepos, type RepoInfo } from "./docker.ts";
import { TokenProvider } from "./creds/token.ts";
import { SocketManager } from "./creds/server.ts";
import { ProxyManager } from "./creds/proxy.ts";
import { msg } from "./zerg.ts";

const config = loadConfig();

mkdirSync(config.socketDir, { recursive: true });

const tp = new TokenProvider(config);
const sm = new SocketManager(config.socketDir, tp);
const pm = new ProxyManager(config.socketDir);
const docker = new Docker();

// Recovery: recreate sockets/proxies for existing drones
async function recover() {
  console.log(msg.recovering);
  const drones = await listDrones(docker);
  for (const d of drones) {
    if (d.state === "running" && d.repo) {
      const info = readRepoInfo(config.socketDir, d.name);
      if (info && info.provider === "forgejo" && info.host) {
        const forgejoHost = config.forgejo[info.host];
        if (forgejoHost) {
          pm.createProxy(d.name, info.repos, forgejoHost, info.fakeToken);
        }
      } else {
        const repos = info?.repos ?? parseRepos(d.repo);
        sm.createSocket(d.name, repos);
        writeRepos(config.socketDir, d.name, repos);
      }
    }
  }
}

// Watch Docker events
async function watchEvents() {
  const stream = await docker.getEvents({
    filters: {
      type: ["container"],
      label: [`${LABEL_MANAGED}=true`],
    },
  });

  console.log("Watching Docker events...");

  stream.on("data", (chunk: Buffer) => {
    const event = JSON.parse(chunk.toString());
    const droneName = event.Actor?.Attributes?.[LABEL_DRONE];
    if (!droneName) return;

    if (event.Action === "start") {
      const repo = event.Actor.Attributes[LABEL_REPO];
      const info = readRepoInfo(config.socketDir, droneName);

      if (info && info.provider === "forgejo" && info.host) {
        const forgejoHost = config.forgejo[info.host];
        if (forgejoHost) {
          pm.createProxy(droneName, info.repos, forgejoHost, info.fakeToken);
        }
      } else {
        const repos = info?.repos ?? parseRepos(repo);
        sm.createSocket(droneName, repos);
        writeRepos(config.socketDir, droneName, repos);
      }
    } else if (event.Action === "stop" || event.Action === "die") {
      sm.removeSocket(droneName);
      pm.removeProxy(droneName);
    }
  });

  stream.on("error", (err: Error) => {
    console.error("Docker event stream error:", err);
    process.exit(1);
  });
}

function parseRepos(repo: string): string[] {
  return repo
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
}

// Management socket for runtime repo updates from CLI
function startManagementSocket() {
  const socketPath = join(config.socketDir, "_management.sock");
  try { unlinkSync(socketPath); } catch {}

  const server = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/update") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const { drone, repos } = JSON.parse(body);
          if (!drone || !Array.isArray(repos) || repos.length === 0) {
            res.writeHead(400);
            res.end("Invalid request: need drone and non-empty repos array");
            return;
          }
          sm.updateSocket(drone, repos);
          writeRepos(config.socketDir, drone, repos);
          console.log(`${msg.repoUpdated} [${drone}] → ${repos.join(", ")}`);
          res.writeHead(200);
          res.end("OK");
        } catch (err) {
          res.writeHead(500);
          res.end(String(err));
        }
      });
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  server.listen(socketPath, () => {
    chmodSync(socketPath, 0o666);
    console.log(`Management socket ready at ${socketPath}`);
  });

  return server;
}

// Graceful shutdown
let mgmtServer: ReturnType<typeof createServer>;

process.on("SIGINT", () => {
  console.log("Shutting down...");
  sm.shutdown();
  pm.shutdown();
  mgmtServer?.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  sm.shutdown();
  pm.shutdown();
  mgmtServer?.close();
  process.exit(0);
});

await recover();
mgmtServer = startManagementSocket();
await watchEvents();
