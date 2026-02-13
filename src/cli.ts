#!/usr/bin/env -S node --experimental-strip-types

import { existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { Command } from "commander";
import { loadConfig } from "./config.ts";
import {
  createClient,
  droneName,
  findDrone,
  listDrones,
  stopDrone,
  startDrone,
  removeDrone,
} from "./docker.ts";
import { spawn } from "./spawn.ts";
import { msg, status, HatcheryError } from "./zerg.ts";

/** Resolve a CLI argument to the drone name, handling both local paths and org/repo. */
function resolveDroneName(repo: string): string {
  const localPath = resolve(repo);
  if (existsSync(localPath)) {
    return `hatchery-${basename(localPath)}`;
  }
  return droneName(repo);
}

const program = new Command();

program.name("hatchery").description("Manage devcontainer drones on the hive");

program
  .command("spawn")
  .argument("<org/repo>", "GitHub repository to spawn")
  .description("Spawn a new drone from a GitHub repository")
  .action(async (repo: string) => {
    const config = loadConfig();
    const docker = createClient();
    await spawn(docker, repo, config);
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

program.parseAsync().catch((err) => {
  if (err instanceof HatcheryError) {
    console.error(`\n  ${err.message}\n`);
    process.exit(1);
  }
  throw err;
});
