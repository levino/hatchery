#!/usr/bin/env -S node --experimental-strip-types

import { existsSync } from "node:fs";
import { resolve, basename, join } from "node:path";
import { request } from "node:http";
import { Command } from "commander";
import { loadConfig } from "./config.ts";
import {
  createClient,
  droneName,
  forgejoFroneName,
  findDrone,
  listDrones,
  stopDrone,
  startDrone,
  removeDrone,
  readRepos,
} from "./docker.ts";
import { spawn } from "./spawn.ts";
import { msg, status, HatcheryError } from "./zerg.ts";

/** Resolve a CLI argument to the drone name, handling local paths, org/repo, and host/org/repo. */
function resolveDroneName(repo: string): string {
  const localPath = resolve(repo);
  if (existsSync(localPath)) {
    return `hatchery-${basename(localPath)}`;
  }
  const parts = repo.split("/");
  if (parts.length === 3) {
    return forgejoFroneName(parts[0], `${parts[1]}/${parts[2]}`);
  }
  return droneName(repo);
}

const program = new Command();

program.name("hatchery").description("Manage devcontainer drones on the hive");

program
  .command("spawn")
  .argument("<repo>", "Repository to spawn (org/repo for GitHub, host/org/repo for Forgejo)")
  .option("--repos <repos>", "Additional repos for token access (comma-separated org/repo)")
  .option("--hostname <hostname>", "Override Tailscale hostname for the drone")
  .description("Spawn a new drone from a repository")
  .action(async (repo: string, opts: { repos?: string; hostname?: string }) => {
    const config = loadConfig();
    const docker = createClient();
    const extraRepos = opts.repos ? opts.repos.split(",").map((r: string) => r.trim()) : [];
    await spawn(docker, repo, config, extraRepos, opts.hostname);
  });

program
  .command("list")
  .description("List all drones in the hive")
  .action(async () => {
    const docker = createClient();
    const drones = await listDrones(docker);
    if (drones.length === 0) {
      console.log(msg.noDrones);
      return;
    }
    for (const d of drones) {
      console.log(status(d.name, d.state));
    }
  });

program
  .command("status")
  .argument("<org/repo>", "GitHub repository")
  .description("Show status of a specific drone")
  .action(async (repo: string) => {
    const docker = createClient();
    const name = resolveDroneName(repo);
    const d = await findDrone(docker, name);
    if (!d) {
      console.error(msg.droneNotFound);
      process.exit(1);
    }
    console.log(status(d.name, d.state));
    console.log(`  Repo:      ${d.repo}`);
    console.log(`  Container: ${d.id.slice(0, 12)}`);
  });

program
  .command("burrow")
  .argument("<org/repo>", "GitHub repository")
  .description("Stop a drone (burrow underground)")
  .action(async (repo: string) => {
    const docker = createClient();
    const name = resolveDroneName(repo);
    const d = await findDrone(docker, name);
    if (!d) {
      console.error(msg.droneNotFound);
      process.exit(1);
    }
    await stopDrone(docker, d.id);
    console.log(msg.burrowComplete);
  });

program
  .command("unburrow")
  .argument("<org/repo>", "GitHub repository")
  .description("Start a stopped drone (emerge from the ground)")
  .action(async (repo: string) => {
    const docker = createClient();
    const name = resolveDroneName(repo);
    const d = await findDrone(docker, name);
    if (!d) {
      console.error(msg.droneNotFound);
      process.exit(1);
    }
    await startDrone(docker, d.id);
    console.log(msg.unburrowComplete);
  });

program
  .command("slay")
  .argument("<org/repo>", "GitHub repository")
  .description("Remove a drone permanently")
  .action(async (repo: string) => {
    const docker = createClient();
    const name = resolveDroneName(repo);
    const d = await findDrone(docker, name);
    if (!d) {
      console.error(msg.droneNotFound);
      process.exit(1);
    }
    await removeDrone(docker, d.id);
    console.log(msg.slayComplete);
  });

// --- repo subcommands for multi-repo access ---

/** Send a POST to the creds-service management socket. */
function managementRequest(socketDir: string, drone: string, repos: string[]): Promise<void> {
  const socketPath = join(socketDir, "_management.sock");
  const body = JSON.stringify({ drone, repos });
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: "/update", method: "POST" }, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => {
        if (res.statusCode === 200) resolve();
        else reject(new HatcheryError(`Management request failed: ${data}`));
      });
    });
    req.on("error", (err) => reject(new HatcheryError(`Cannot reach creds-service: ${err.message}`)));
    req.end(body);
  });
}

const repoCmd = program
  .command("repo")
  .description("Manage multi-repo access for drones");

repoCmd
  .command("list")
  .argument("<org/repo>", "Drone identifier (org/repo or local path)")
  .description("List repos a drone has token access to")
  .action(async (repo: string) => {
    const config = loadConfig();
    const name = resolveDroneName(repo);
    const repos = readRepos(config.socketDir, name);
    if (!repos) {
      console.error(msg.droneNotFound);
      process.exit(1);
    }
    console.log(`Repos for ${name}:`);
    for (const r of repos) {
      console.log(`  ${r}`);
    }
  });

repoCmd
  .command("connect")
  .argument("<org/repo>", "Drone identifier (org/repo or local path)")
  .argument("<extra-repo>", "Repository to add access for (org/repo)")
  .description("Grant a drone token access to an additional repo")
  .action(async (repo: string, extraRepo: string) => {
    const config = loadConfig();
    const docker = createClient();
    const name = resolveDroneName(repo);
    const drone = await findDrone(docker, name);
    if (!drone) {
      console.error(msg.droneNotFound);
      process.exit(1);
    }
    const currentRepos = readRepos(config.socketDir, name) ?? drone.repo.split(",").map((r: string) => r.trim()).filter(Boolean);
    if (currentRepos.includes(extraRepo)) {
      console.log(msg.repoAlreadyConnected);
      return;
    }
    const newRepos = [...currentRepos, extraRepo];
    await managementRequest(config.socketDir, name, newRepos);
    console.log(msg.repoConnected);
  });

repoCmd
  .command("disconnect")
  .argument("<org/repo>", "Drone identifier (org/repo or local path)")
  .argument("<extra-repo>", "Repository to remove access for (org/repo)")
  .description("Revoke a drone's token access to a repo")
  .action(async (repo: string, extraRepo: string) => {
    const config = loadConfig();
    const docker = createClient();
    const name = resolveDroneName(repo);
    const drone = await findDrone(docker, name);
    if (!drone) {
      console.error(msg.droneNotFound);
      process.exit(1);
    }
    const currentRepos = readRepos(config.socketDir, name) ?? drone.repo.split(",").map((r: string) => r.trim()).filter(Boolean);
    if (!currentRepos.includes(extraRepo)) {
      console.log(msg.repoNotConnected);
      return;
    }
    const newRepos = currentRepos.filter((r: string) => r !== extraRepo);
    if (newRepos.length === 0) {
      console.error(msg.repoCannotRemovePrimary);
      process.exit(1);
    }
    await managementRequest(config.socketDir, name, newRepos);
    console.log(msg.repoDisconnected);
  });

program.parseAsync().catch((err) => {
  if (err instanceof HatcheryError) {
    console.error(`\n  ${err.message}\n`);
    process.exit(1);
  }
  throw err;
});
