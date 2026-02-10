# Hatchery: Self-Hosted Remote Development Environment

## Problem

I develop across two machines (Linux laptop, Mac Studio) and want to run devcontainers on a dedicated server. The existing tools (DevPod, Coder, GitHub Codespaces) each solve parts of this but come with significant baggage — local state that doesn't sync, Kubernetes dependencies, vendor lock-in, or proprietary protocols.

I also need scoped GitHub credentials per drone. Currently I either use manually created fine-grained PATs (cumbersome, limited UI functionality) or forward my SSH key into containers (dangerous — AI agents in the container get my full GitHub identity).

## Goals

- Run devcontainers ("drones") on a remote server, accessible from any machine with zero client-side configuration
- Each drone is identified by its repository — no separate naming
- Scoped GitHub credentials per drone that refresh automatically
- Works with VS Code, JetBrains, Neovim, terminal SSH — anything that speaks SSH
- Minimal infrastructure, minimal custom code

## Architecture Overview

### Networking: Headscale/Tailscale

Each drone joins the existing Headscale tailnet as an individual node. From any machine on the tailnet, a drone is reachable by hostname — like any other machine on the network.

This also means non-SSH traffic works transparently. A web server on port 3000 inside the container is accessible at `http://levinkeller-homepage.tail.levinkeller.de:3000` from any machine on the tailnet. No port forwarding, no tunnels.

**Security**: A dedicated `devcontainer` user in Headscale owns all drone nodes. ACLs restrict this user to inbound-only — drones can accept connections from personal machines but cannot reach anything else on the tailnet. Internet access is unaffected (it goes through Docker's normal NAT, not Tailscale). The pre-auth key is reusable (one key for all drones) and ephemeral (nodes deregister automatically when drones stop).

### Container Lifecycle: devcontainer CLI

The standard `@devcontainers/cli` from Microsoft handles container creation. It reads `devcontainer.json`, builds images, installs features, and manages the container. This is the same tool that VS Code and GitHub Codespaces use internally.

Repos are cloned into Docker volumes (not bind-mounted from the host) for performance and cleanliness.

### SSH Access: devcontainer sshd feature

Each repo's `devcontainer.json` includes the standard sshd feature (`ghcr.io/devcontainers/features/sshd:1`), which starts an SSH server on port 2222 inside the container. This is required for VS Code Remote-SSH to work — it needs the full SSH protocol (multiplexed channels, SFTP, port forwarding), which a plain `docker exec` cannot provide.

### State: Docker Labels

Docker is the sole source of truth. The devcontainer CLI already sets labels like `devcontainer.local_folder` and `devcontainer.config_file` on containers. Additional labels (repo URL, drone name) can be added at creation time. Listing drones is a `docker ps --filter label=...` query. No database, no config files to sync.

### CLI Wrapper

A thin CLI on the server orchestrates the above:

```
hatchery spawn levinkeller/homepage
hatchery list
hatchery burrow levinkeller/homepage
hatchery unburrow levinkeller/homepage
hatchery slay levinkeller/homepage
```

`spawn` clones the repo into a Docker volume, runs `devcontainer up`, waits for Tailscale to connect, and prints the hostname. `burrow`/`unburrow` stop and start drones. `slay` removes them.

### Hostnames

The repo identity is the hostname everywhere. `levinkeller/homepage` becomes `levinkeller-homepage` as the Tailscale hostname, Docker container name, credential socket name, and label value. No separate workspace names, no mapping tables.

```
ssh -p 2222 node@levinkeller-homepage.tail.levinkeller.de
```

## GitHub Credentials: Per-Drone Scoped Tokens

### The Problem with Existing Approaches

- **Fine-grained PATs**: Manual creation, manual scoping, manual revocation, limited GitHub UI functionality (e.g. checking CI runs)
- **SSH key forwarding**: Gives the container your full GitHub identity — any process (including AI agents) can act as you across all repos
- **Classic PATs**: Broad scope, long-lived, no per-repo restriction

### Solution: GitHub App + Per-Drone Credential Socket

A GitHub App is installed on the relevant repos/org. A credential service on the host generates short-lived installation access tokens scoped to specific repositories.

**Why a GitHub App**: Installation access tokens support both git operations and the full GitHub API (PRs, issues, CI status, etc.). They expire after 1 hour automatically. They can be scoped to specific repos at creation time.

### Credential Isolation via Unix Sockets

Each drone gets its own Unix socket mounted from the host. The credential service creates one socket per drone, each pre-configured with the repos that drone is allowed to access. This is a standard Docker pattern (shared volume with a Unix socket, similar to how Envoy/OPA sidecars work in Kubernetes).

The socket approach was chosen over HTTP-on-Docker-network because it requires no authentication layer. The identity is the mount itself — only the drone that has the socket mounted can talk to it. A shared HTTP endpoint would require an auth mechanism to prevent one drone from requesting tokens for another drone's repos.

**Setup at drone creation**:
1. CLI tells credential service: "create socket for `levinkeller-homepage`, scoped to repo `levinkeller/homepage`"
2. Service creates `/var/run/hatchery/levinkeller-homepage.sock` and starts listening
3. Socket is mounted into the drone at `/var/run/github-creds.sock`

**Token caching**: The service caches tokens per repo. When a drone requests a token, the service returns the cached token if it has >5 minutes of validity remaining, otherwise generates a new one. GitHub App installation tokens expire after 1 hour. There is no meaningful rate limit on token creation — the limit is on API requests made *with* the token (5,000/hour).

**Service recovery**: The credential service is stateless. If it restarts, it queries Docker for all running drones with hatchery labels, recreates sockets, and resumes. Docker is the source of truth.

### Drone-Side Integration

Two integration points are needed inside each drone:

**Git credential helper** — a script that git calls whenever it needs auth:

```bash
#!/bin/sh
TOKEN=$(curl -s --unix-socket /var/run/github-creds.sock http://localhost/token)
echo "protocol=https"
echo "host=github.com"
echo "username=x-access-token"
echo "password=$TOKEN"
```

Configured via `git config credential.helper /usr/local/bin/git-credential-hatchery`. Git never stores a token — every operation gets a fresh one from the socket.

**`gh` CLI wrapper** — `gh` doesn't use git credential helpers, it uses `GH_TOKEN` or its own auth store. A wrapper script replaces the `gh` binary:

```bash
#!/bin/sh
export GH_TOKEN=$(curl -s --unix-socket /var/run/github-creds.sock http://localhost/token)
exec /usr/bin/gh "$@"
```

AI agents and other tools that call `gh` get a scoped, short-lived token transparently. They cannot escalate to other repos because the socket only serves tokens for the repos configured at drone creation time.

## What Each Repo's devcontainer.json Needs

```json
{
  "features": {
    "ghcr.io/devcontainers/features/sshd:1": {},
    "ghcr.io/tailscale/codespace/tailscale": {}
  }
}
```

Everything else (credential socket mounting, label assignment, Tailscale auth key injection) is handled by the `hatchery` CLI wrapper at creation time. The repos remain portable — the same `devcontainer.json` works in GitHub Codespaces or local VS Code.

## Components Summary

| Component | Build or Buy | Notes |
|---|---|---|
| devcontainer CLI | Buy (npm package from Microsoft) | Handles container lifecycle, features, image building |
| Headscale | Already running | Provides mesh networking, DNS, ACLs |
| Tailscale devcontainer feature | Buy (community feature) | Joins drone to tailnet |
| sshd devcontainer feature | Buy (official feature) | SSH server on port 2222 |
| `hatchery` CLI | Build (~200 lines bash/Go) | Orchestrates spawn/list/burrow/unburrow/slay |
| Credential service | Build (~300-400 lines Go) | GitHub App token generation, per-drone sockets |
| Git credential helper | Build (~10 lines shell) | Calls credential socket |
| `gh` wrapper | Build (~5 lines shell) | Injects token into `gh` CLI |

## What This Replaces

- **DevPod**: Solves the multi-machine state sync problem (Docker is the state, accessible from any machine on the tailnet). Eliminates the broken client-side state model where workspace metadata lives on the wrong machine.
- **Manual PATs**: Automated, scoped, short-lived tokens with no manual creation or revocation.
- **SSH key forwarding**: Drones get only the permissions they need, for the repos they need. Compromised agents cannot access other repos.
- **GitHub Codespaces**: Self-hosted, no per-minute billing, no vendor lock-in, works with any editor.

## CLI Personality

The CLI uses Starcraft Zerg lingo for commands and error messages:

| Command | Action |
|---|---|
| `hatchery spawn <org/repo>` | Create and start a drone |
| `hatchery slay <org/repo>` | Remove a drone |
| `hatchery burrow <org/repo>` | Stop a drone |
| `hatchery unburrow <org/repo>` | Start a stopped drone |
| `hatchery list` | List all drones |
| `hatchery status <org/repo>` | Drone status and resource usage |

Example error messages:

| Situation | Message |
|---|---|
| Repository not found | `We require more minerals.` |
| Max containers reached | `Spawn more overlords. Insufficient vespene gas.` |
| Container OOM / high memory | `Nuclear launch detected.` |
| Drone not found | `Your warriors have engaged the enemy. ...just kidding. Drone not found.` |
| Drone already exists | `Evolution chamber occupied.` |
| Spawn successful | `Spawning drone... 🟢 Hatchery ready.` |
