# Implementation Status

## Working

- **Spawn flow**: clone, devcontainer up (detached + poll), run-user-commands, Tailscale wait, VS Code URI output
- **Local path support**: `hatchery spawn ./test-repo` auto-detected
- **SSH key injection**: fetched from `github.com/<user>.keys`, injected via `docker exec` into UID 1000 user
- **GitHub credential sockets**: `TokenProvider` + `SocketManager` create per-drone Unix sockets serving scoped installation tokens
- **Credential scripts**: git credential helper + `gh` CLI wrapper installed inside container via `docker exec`
- **Drone management**: list, status, burrow (stop), unburrow (start), slay (remove)
- **Tailscale/Headscale**: feature provides TUN + keep-alive, `HATCHERY_TS_*` env vars prevent auto-start, manual `tailscale up` in postStartCommand
- **Drone naming**: `hatchery-` prefix for all drones (Tailscale DNS grouping, SSH config wildcards)

## Needs Testing

- **Credential script installation on fresh spawn**: the `printf`-based injection via `docker exec` was rewritten but not yet end-to-end tested on a clean spawn. Manually verified working inside a running container.

## Known Issues

- **SSH user mismatch**: SSH config uses `User vscode` but some images use `node` as UID 1000. SSH key injection targets UID 1000 regardless, but the SSH `User` must match the actual username.
- **Socket lifetime**: credential sockets die when the hatchery process exits. The standalone `hatchery-creds` service (`src/creds-service.ts`) exists but is not integrated into the spawn flow yet. It watches Docker events and would handle recovery.
- **`capAdd` in repo configs**: `test-repo` devcontainer.json has `"capAdd": ["NET_ADMIN", "NET_RAW"]` but the tailscale feature should handle this itself. Needs investigation.

## Not Yet Implemented

- `--mode` flag for spawn (`github` / `local` / `ssh`)
- Repo cleanup on slay (cloned repos persist in `~/.hatchery/repos/`)
- Error handling for missing `devcontainer.json`
- Proper build tooling (Makefile, etc.)
- Integration of standalone `hatchery-creds` service for persistent socket management
