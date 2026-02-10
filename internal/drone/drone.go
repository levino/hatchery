package drone

import (
	"strings"
)

// Docker label constants
const (
	LabelManaged = "hatchery.managed"
	LabelDrone   = "hatchery.drone"
	LabelRepo    = "hatchery.repo"
)

// Drone represents a managed devcontainer.
type Drone struct {
	Name  string // e.g. "levinkeller-homepage"
	Repo  string // e.g. "levinkeller/homepage"
	ID    string // Docker container ID
	State string // running, exited, etc.
}

// DroneName converts "org/repo" to "org-repo".
func DroneName(repo string) string {
	return strings.ReplaceAll(repo, "/", "-")
}

// VolumeName returns the Docker volume name for a drone.
func VolumeName(name string) string {
	return "hatchery-" + name
}

// Hostname returns the full Tailscale hostname for a drone.
func Hostname(name, domain string) string {
	return name + "." + domain
}
