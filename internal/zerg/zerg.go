package zerg

import "fmt"

// Themed error messages
const (
	MsgDroneNotFound    = "Your warriors have engaged the enemy. ...just kidding. Drone not found."
	MsgDroneExists      = "Evolution chamber occupied."
	MsgSpawnStarting    = "Spawning drone..."
	MsgSpawnComplete    = "Spawning drone... \U0001f7e2 Hatchery ready."
	MsgSlayComplete     = "Drone eliminated. The swarm grows weaker."
	MsgBurrowComplete   = "Drone burrowed. Awaiting further orders."
	MsgUnburrowComplete = "Drone unburrowed. Ready for combat."
	MsgNoDrones         = "The hive is empty. Spawn some drones."
	MsgRepoNotFound     = "We require more minerals."
	MsgTooManyDrones    = "Spawn more overlords. Insufficient vespene gas."
	MsgHighMemory       = "Nuclear launch detected."
	MsgCloning          = "Assimilating genetic material..."
	MsgWaitingTailscale = "Awaiting neural link..."
	MsgDockerError      = "Creep tumor malfunction."
	MsgSocketCreated    = "Extractor online."
	MsgSocketRemoved    = "Extractor offline."
	MsgTokenRefreshed   = "Essence absorbed."
	MsgRecovering       = "Rebuilding creep network..."
)

// Status formats a drone status line for list output.
func Status(name, state string) string {
	icon := "\U0001f534" // red
	switch state {
	case "running":
		icon = "\U0001f7e2" // green
	case "exited":
		icon = "\u26aa" // white
	}
	return fmt.Sprintf("  %s %s [%s]", icon, name, state)
}

// Errorf wraps a message in zerg flavor.
func Errorf(msg string, args ...any) error {
	return fmt.Errorf(msg, args...)
}

// Printf prints a themed message to stdout.
func Printf(msg string, args ...any) {
	fmt.Printf(msg+"\n", args...)
}
