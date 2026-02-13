export class HatcheryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HatcheryError";
  }
}

export const msg = {
  droneNotFound:
    "Your warriors have engaged the enemy. ...just kidding. Drone not found.",
  droneExists:
    "A drone for this repo is already running. Slay it first, or use unburrow.\n  Evolution chamber occupied — one larva per cocoon, Overmind.",
  spawnStarting: "Spawning drone...",
  spawnComplete: "Spawning drone... 🟢 Hatchery ready.",
  slayComplete: "Drone eliminated. The swarm grows weaker.",
  burrowComplete: "Drone burrowed. Awaiting further orders.",
  unburrowComplete: "Drone unburrowed. Ready for combat.",
  noDrones: "The hive is empty. Spawn some drones.",
  repoNotFound: "We require more minerals.",
  tooManyDrones: "Spawn more overlords. Insufficient vespene gas.",
  highMemory: "Nuclear launch detected.",
  cloning: "Assimilating genetic material...",
  dockerError: "Creep tumor malfunction.",
  socketCreated: "Extractor online.",
  socketRemoved: "Extractor offline.",
  tokenRefreshed: "Essence absorbed.",
  recovering: "Rebuilding creep network...",
  spawnTimeout:
    "Container did not start within 2 minutes. Check Docker logs for details.\n  Drone lost in the Nydus Network — spawning sequence timed out.",
  updating: "Absorbing latest mutations...",
  noEvolutionPlan:
    "No devcontainer.json found in the repo. Add one so the drone knows how to build.\n  The spawning pool rejects unsequenced DNA — evolution requires a build plan.",
};

export function status(name: string, state: string): string {
  const icon =
    state === "running" ? "🟢" : state === "exited" ? "⚪" : "🔴";
  return `  ${icon} ${name} [${state}]`;
}
