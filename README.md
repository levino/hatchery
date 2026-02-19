# Hatchery

Self-hosted remote dev environment manager. Runs devcontainers ("drones") on a server, connects them to your Headscale/Tailscale network, and provides scoped GitHub credentials per drone.

## Why

- Develop across multiple machines without syncing state — Docker is the source of truth
- Each drone gets its own short-lived GitHub token scoped to specific repos (no SSH key forwarding, no manual PATs)
- Works with VS Code, JetBrains, Neovim, terminal SSH — anything that speaks SSH
- Repos stay portable — same `devcontainer.json` works in Codespaces or locally
- Git worktree support — create multiple worktrees inside a drone, all persisted on the host

## How It Works

### Spawn Flow

```mermaid
sequenceDiagram
    participant User
    participant Hatchery as hatchery CLI
    participant Docker
    participant DC as devcontainer CLI
    participant GH as GitHub API
    participant HS as Headscale

    User->>Hatchery: hatchery spawn org/repo
    Hatchery->>Hatchery: git clone repo to ~/.hatchery/repos/name/worktrees/main/
    Hatchery->>GH: Create installation token (JWT + RS256)
    GH-->>Hatchery: Scoped access token
    Hatchery->>Hatchery: Create Unix socket (~/.hatchery/sockets/name.sock)
    Hatchery->>DC: devcontainer up --additional-features (sshd + tailscale + hatchery)
    Note over DC: --remote-env injects TS auth key, hostname, GitHub user
    DC->>Docker: Build image + start container
    Note over DC,Docker: hatchery feature install.sh: write credential helpers
    Hatchery->>Docker: Poll until container is running
    Docker-->>Hatchery: Container running
    Hatchery->>DC: devcontainer run-user-commands
    Note over DC,Docker: hatchery feature postStartCommand: SSH keys + tailscale up
    DC->>HS: Join tailnet
    Hatchery->>HS: Wait for DNS resolution
    Hatchery-->>User: ssh vscode@hatchery-org-repo
```

### Networking

Each drone joins the Headscale tailnet as its own node. From any machine on the tailnet, drones are reachable by hostname — like any other machine on the network. No port forwarding, no tunnels.

```mermaid
graph LR
    subgraph "Your machines"
        VS[VS Code / SSH]
    end

    subgraph "Headscale Tailnet"
        HS[Headscale Server]
    end

    subgraph "Host Server"
        subgraph "Docker"
            D1[hatchery-org-repo<br/>SSHD :2222<br/>Tailscale]
            D2[hatchery-other-repo<br/>SSHD :2222<br/>Tailscale]
        end
        S1[creds.sock]
        S2[creds.sock]
    end

    VS -- "SSH via Tailscale DNS" --> D1
    VS -- "SSH via Tailscale DNS" --> D2
    D1 -- "tailscale up" --> HS
    D2 -- "tailscale up" --> HS
    VS -- "tailscale" --> HS
    D1 -. "GET /token" .-> S1
    D2 -. "GET /token" .-> S2
```

### Scoped GitHub Credentials

A GitHub App generates short-lived installation tokens scoped to specific repos. Each drone gets a Unix socket that serves tokens on demand. Inside the container, a git credential helper and `gh` CLI wrapper call the socket transparently.

```mermaid
sequenceDiagram
    participant Tool as git/gh inside drone
    participant Script as credential helper
    participant Socket as Unix socket<br/>(host-side)
    participant TP as TokenProvider
    participant GH as GitHub API

    Tool->>Script: git push / gh pr create
    Script->>Socket: curl --unix-socket /var/run/github-creds.sock /token
    Socket->>TP: getToken([repo])
    alt Token cached & valid (>5min remaining)
        TP-->>Socket: cached token
    else Token expired or missing
        TP->>GH: POST /app/installations/:id/access_tokens
        GH-->>TP: scoped token (1hr TTL)
        TP-->>Socket: fresh token
    end
    Socket-->>Script: token string
    Script-->>Tool: credentials / GH_TOKEN
```

### Git Worktree Support

Hatchery mounts the `worktrees/` directory into the container, enabling `git worktree` usage where all worktrees are persisted on the host.

```
~/.hatchery/repos/<drone-name>/
└── worktrees/           # mounted as --workspace-folder
    ├── main/            # git clone (initial working tree, has .git/)
    ├── feature-branch/  # git worktree (created inside container)
    └── bugfix/          # git worktree
```

Inside a drone, create worktrees relative to the main clone:

```bash
cd /workspaces/main
git worktree add ../feature-branch feature-branch
```

The worktree lives alongside the main clone on the host filesystem, surviving container restarts.

## CLI Commands

| Command | Action |
|---|---|
| `hatchery spawn <org/repo>` | Clone, build, and start a drone |
| `hatchery spawn <local-path>` | Spawn from a local directory |
| `hatchery list` | List all drones |
| `hatchery status <org/repo>` | Show drone details |
| `hatchery burrow <org/repo>` | Stop a drone |
| `hatchery unburrow <org/repo>` | Start a stopped drone |
| `hatchery slay <org/repo>` | Remove a drone permanently |

## Repo Requirements

Any repo with a `devcontainer.json` works out of the box. Hatchery automatically injects sshd, Tailscale, and a custom hatchery feature at spawn time via `--additional-features`. The hatchery feature installs credential helpers at build time and runs SSH key injection + Tailscale join via its `postStartCommand`. Repos do not need any hatchery-specific configuration. The same `devcontainer.json` works in GitHub Codespaces or local VS Code without modification.

## Setup

```bash
cp .env.example .env              # fill in values
cp config.example.json config.json  # add GitHub App installation IDs
npm install
npm run hatchery -- spawn org/repo
```

### SSH Config

```
Host hatchery-*
  User vscode
  Port 2222
```

## Stack

- TypeScript (Node.js with `--experimental-strip-types`)
- `@devcontainers/cli` for container lifecycle
- `dockerode` for Docker API
- Headscale/Tailscale for mesh networking
- GitHub App for scoped credentials
