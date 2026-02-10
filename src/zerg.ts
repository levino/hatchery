export const msg = {
  droneNotFound:
    "Your warriors have engaged the enemy. ...just kidding. Drone not found.",
  droneExists: "Evolution chamber occupied.",
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
};

export function status(name: string, state: string): string {
  const icon =
    state === "running" ? "🟢" : state === "exited" ? "⚪" : "🔴";
  return `  ${icon} ${name} [${state}]`;
}
