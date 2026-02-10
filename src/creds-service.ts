#!/usr/bin/env -S node --experimental-strip-types

import { mkdirSync } from "node:fs";
import Docker from "dockerode";
import { loadConfig, requireCredentials } from "./config.ts";
import { LABEL_MANAGED, LABEL_DRONE, LABEL_REPO, listDrones } from "./docker.ts";
import { TokenProvider } from "./creds/token.ts";
import { SocketManager } from "./creds/server.ts";
import { msg } from "./zerg.ts";

const config = loadConfig();
requireCredentials(config);

mkdirSync(config.socketDir, { recursive: true });

const tp = new TokenProvider(config);
const sm = new SocketManager(config.socketDir, tp);
const docker = new Docker();

// Recovery: recreate sockets for existing drones
async function recover() {
  console.log(msg.recovering);
  const drones = await listDrones(docker);
  for (const d of drones) {
    if (d.state === "running" && d.repo) {
      sm.createSocket(d.name, parseRepos(d.repo));
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
      sm.createSocket(droneName, parseRepos(repo));
    } else if (event.Action === "stop" || event.Action === "die") {
      sm.removeSocket(droneName);
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

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("Shutting down...");
  sm.shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  sm.shutdown();
  process.exit(0);
});

await recover();
await watchEvents();
