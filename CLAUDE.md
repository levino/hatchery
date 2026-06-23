# Hatchery - Project Context

Self-hosted remote dev environment manager. Spawns devcontainers as "drones" with automatic GitHub credentials, SSH access, and Tailscale/Headscale networking.

See [README.md](README.md) for full architecture docs.

## Quick Reference

### Tech Stack
- **Runtime**: Node.js with `--experimental-strip-types` (native TS, no build step needed)
- **Key deps**: commander (CLI), dockerode (Docker API), @devcontainers/cli, jsonwebtoken (GitHub App JWT)
- **Language**: TypeScript (ESM, `"type": "module"`)

### Two Processes
1. **`hatchery` CLI** (`src/cli.ts`) — user-facing commands: spawn, list, status, burrow, unburrow, slay, reauth [org/repo] (rebuild Tailscale session — all running drones, or one), repo connect/disconnect/list (multi-repo token access)
2. **`hatchery-creds` service** (`src/creds-service.ts`) — persistent Docker Compose service that watches Docker events and creates per-drone Unix sockets for GitHub token delivery

### Spawn Flow (what happens when you run `hatchery spawn levino/nordstemmen-ai`)
1. Drone name = `hatchery-levino-nordstemmen-ai`
2. Git clone via SSH to `~/.hatchery/repos/hatchery-levino-nordstemmen-ai/worktrees/main/` (or `git pull --ff-only` if exists)
3. Find `devcontainer.json` in repo
4. `devcontainer up` with injected features (sshd, tailscale, hatchery credential helper)
5. Bind-mount `~/.hatchery/sockets/<drone-name>/` into container at `/var/run/hatchery-sockets/`
6. Poll Docker API for container running state (120s timeout)
7. `devcontainer run-user-commands` (triggers postStartCommand from hatchery feature)
8. Output SSH connection string and VS Code URI

### Credential Flow
- **Host**: creds-service creates Unix socket per drone at `~/.hatchery/sockets/<drone>/creds.sock`
- **Container**: socket mounted at `/var/run/hatchery-sockets/creds.sock`
- **git**: credential helper curls socket → gets GitHub App installation token
- **gh CLI**: wrapper sets `GH_TOKEN` from socket before calling real `gh`
- **SSH→HTTPS rewrite**: `git config url."https://github.com/".insteadOf "git@github.com:"` so SSH clone URLs work with the HTTPS credential helper

### Key Files
| File | Purpose |
|------|---------|
| `src/cli.ts` | CLI entry (commander), all user commands |
| `src/spawn.ts` | Spawn orchestration: clone, devcontainer up, polling |
| `src/docker.ts` | Docker helpers: list/find/stop/start/remove drones, labels |
| `src/config.ts` | Config loading from `.env` + `config.json` |
| `src/zerg.ts` | HatcheryError class, Zerg-themed UI messages |
| `src/creds-service.ts` | Persistent service: Docker event watcher, socket lifecycle |
| `src/creds/token.ts` | GitHub App JWT creation, installation token API calls |
| `src/creds/server.ts` | SocketManager: per-drone HTTP-over-Unix-socket servers |
| `features/hatchery/install.sh` | Devcontainer feature: credential helpers, SSH keys, Tailscale, dev tools (zellij + Claude Code), fallback Claude `CLAUDE.md` |
| `features/hatchery/devcontainer-feature.json` | Feature metadata, published to `ghcr.io/levino/hatchery/hatchery:1` |
| `compose.yaml` | Docker Compose for persistent creds-service |
| `Dockerfile` | creds-service container image |

### Configuration
- **`.env`**: `HATCHERY_GITHUB_CLIENT_ID`, `HATCHERY_GITHUB_APP_KEY` (path or PEM), `HATCHERY_GITHUB_USER`, `HATCHERY_HEADSCALE_AUTH_KEY`, `HATCHERY_TAILSCALE_DOMAIN`
- **`config.json`**: `{ "installations": { "org-name": "installation-id" } }` — maps GitHub org to App installation ID. **Gitignored** (host-local state).
- Optional: `HATCHERY_SOCKET_DIR`, `HATCHERY_DOTFILES_REPO`

> **Adding a new org** (so a drone can access its repos): (1) install the `levino-drone` GitHub App on the org (https://github.com/apps/levino-drone/installations/new); (2) add `"<org>": "<installation-id>"` to `config.json`; (3) **restart the creds-service** — `docker restart hatchery-creds-1` — because `creds-service.ts` calls `loadConfig()` once at startup and won't see the new org otherwise (symptom in-drone: `git` fails with `could not read Username … No such device or address`). Per-drone repo-list changes from `repo connect` ARE picked up live; only the `installations` map needs the restart.

### Docker Labels (how drones are tracked)
- `hatchery.managed=true` — identifies hatchery containers
- `hatchery.drone=<name>` — drone name
- `hatchery.repo=<org/repo>` — source repo

### Common Failure Points
1. **Git clone fails**: SSH key not configured or repo doesn't exist
2. **No devcontainer.json**: repo needs one in `.devcontainer/`, root, or `.devcontainer.json`
3. **Spawn timeout (120s)**: container build too slow or Docker issue
4. **Drone already exists**: must `slay` first
5. **Missing org in config.json**: `installationId()` throws if org not in installations map
6. **creds-service not running**: sockets never created, git/gh fail in container
7. **New org added but creds-service not restarted**: in-drone git fails with `could not read Username` even though the org is in `config.json` — restart `hatchery-creds-1` (see Configuration)
8. **Drone SSH**: drones run sshd on port **2222** (password auth disabled); reach them via the Tailscale hostname `hatchery-<org>-<repo>`
9. **Drone unreachable over Tailscale / SSH times out — usually a stale tailnet session**: A long-running drone's `tailscaled` can silently lose its Headscale control-plane session and freeze its netmap. Symptom: the drone still reports `tailscale status` = *Running* locally, but the **host and other peers no longer list it**, `tailscale ping <drone-ip>` from the host says `no matching peer`, and remote `ssh vscode@hatchery-<org>-<repo>` **times out**. Diagnose inside the drone: `docker exec <c> tailscale status` shows **stale peer IPs** (old IPs for the other drones) and the last `netmap`/`derp` line in `/var/log/tailscaled.log` is days old. Key fact: drones sit behind the host with **no inbound UDP forwarding**, so remote peers **always** reach a drone via **DERP relay**, never a direct connection — a wedged `tailscaled` kills that relay while LAN-local access from the host (same subnet, direct) keeps working and masks the problem. **Fix, in order:**
   1. **Surgical re-auth (default fix):** `hatchery reauth <org/repo>` for one drone (or `hatchery reauth` for all running). It runs `tailscale down` then `tailscale up --reset` **inside** the drone, tearing down and rebuilding the wgengine + magicsock/DERP connections in-process — the same effect as restarting tailscaled, which is what un-wedges a stale relay, but **without** restarting the container, so the drone's running dev session survives. Verified: this preserves the drone's tailnet **IP** as long as its node still exists in Headscale (the node key in persisted state is reused). `--reset` by itself does **not** change the IP — a **new IP** only happens after a `PollNetMap … 404: node not found` (the node was deleted from Headscale → forced re-registration). When the IP does change, remote clients with a cached netmap keep hitting the dead IP → timeout until their netmap refreshes.
   2. **Last resort — `docker restart <c>` then `hatchery reauth <org/repo>`.** Only if the surgical reauth above doesn't restore remote reachability. This is the sledgehammer: it kills **every** process in the drone (dev servers, in-flight work), so avoid it unless needed. A bare `docker start`/restart alone won't rejoin the tailnet (env-based auth from `devcontainer up` is not persisted) — that is why reauth must re-run `tailscale up` afterwards.
   3. **Verify from a real REMOTE vantage, not the host.** The host shares the drone's Docker LAN (`10.10.0.0/24`) and always connects **directly** (`tailscale ping` → `via 10.10.0.x`), so `ssh`/`ping` from the host succeed even when remote peers time out — it masks the bug. The Claude Code **sandbox is a valid remote vantage**: it routes into the tailnet via the operator's host, so `ssh -p 2222 node@<drone-tailnet-ip>` (drop a temp pubkey into `/home/node/.ssh/authorized_keys` via `docker exec`, drone user is **`node`**) reproduces the real path. Telltale of the wedge: the TCP connect to `:2222` may even succeed, but SSH dies with `Connection timed out during banner exchange`, and inside the drone `ss -tn | grep 2222` shows **no** established connection — the SYN never reaches sshd. A healthy drone keeps a long-lived DERP conn (`magicsock: N active derp conns: derp-XX=crNNh...`).

### CLI Theme
All user-facing messages use StarCraft Zerg theme (see `src/zerg.ts`). Drones = containers, spawn/slay/burrow/unburrow = start/remove/stop/restart.
