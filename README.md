# Hatchery

Self-hosted remote dev environment manager. Runs devcontainers ("drones") on a server, connects them to your Headscale/Tailscale network, and provides scoped GitHub credentials per drone.

## Why

- Develop across multiple machines without syncing state — Docker is the source of truth
- Each drone gets its own short-lived GitHub token scoped to specific repos (no SSH key forwarding, no manual PATs)
- Works with VS Code, JetBrains, Neovim, terminal SSH — anything that speaks SSH
- Repos stay portable — same `devcontainer.json` works in Codespaces or locally

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
    Hatchery->>Hatchery: git clone repo to ~/.hatchery/repos/
    Hatchery->>GH: Create installation token (JWT + RS256)
    GH-->>Hatchery: Scoped access token
    Hatchery->>Hatchery: Create Unix socket (~/.hatchery/sockets/name.sock)
    Hatchery->>DC: devcontainer up (detached)
    DC->>Docker: Build image + start container
    Hatchery->>Docker: Poll until container is running
    Docker-->>Hatchery: Container running
    Hatchery->>DC: devcontainer run-user-commands
    Note over DC,Docker: postStartCommand: tailscale up
    DC->>HS: Join tailnet
    Hatchery->>Docker: exec: inject SSH keys + credential scripts
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

    subgraph "Hetzner Server"
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

Repos that want to work with Hatchery need this in their `devcontainer.json`:

```json
{
  "features": {
    "ghcr.io/devcontainers/features/sshd:1": {},
    "ghcr.io/tailscale/codespace/tailscale": {}
  },
  "containerEnv": {
    "HATCHERY_TS_AUTH_KEY": "${localEnv:HATCHERY_TS_AUTH_KEY}",
    "HATCHERY_TS_HOSTNAME": "${localEnv:HATCHERY_TS_HOSTNAME}",
    "HATCHERY_TS_LOGIN_SERVER": "${localEnv:HATCHERY_TS_LOGIN_SERVER}"
  },
  "postStartCommand": "sudo tailscale up --login-server=${HATCHERY_TS_LOGIN_SERVER} --authkey=${HATCHERY_TS_AUTH_KEY} --hostname=${HATCHERY_TS_HOSTNAME}"
}
```

Everything else (labels, socket mounts, SSH keys, credential scripts) is handled by hatchery at spawn time.

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
