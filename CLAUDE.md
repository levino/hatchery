# Hatchery - Project Context

Self-hosted remote dev environment manager. Spawns devcontainers as "drones" with automatic GitHub credentials, SSH access, and Tailscale/Headscale networking.

See [README.md](README.md) for full architecture docs.

## Quick Reference

### Tech Stack
- **Runtime**: Node.js with `--experimental-strip-types` (native TS, no build step needed)
- **Key deps**: commander (CLI), dockerode (Docker API), @devcontainers/cli, jsonwebtoken (GitHub App JWT)
- **Language**: TypeScript (ESM, `"type": "module"`)

### Two Processes
1. **`hatchery` CLI** (`src/cli.ts`) — user-facing commands: spawn, list, status, burrow, unburrow, slay, reauth (re-auth Tailscale in all drones), repo connect/disconnect/list (multi-repo token access)
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

### CLI Theme
All user-facing messages use StarCraft Zerg theme (see `src/zerg.ts`). Drones = containers, spawn/slay/burrow/unburrow = start/remove/stop/restart.
