#!/bin/sh
set -e

# --- Claude Code config directory (persistent across rebuilds) ---
CLAUDE_DIR="/workspaces/.claude"
mkdir -p "$CLAUDE_DIR"
cat > "$CLAUDE_DIR/CLAUDE.md" <<'CLAUDEMD'
# Hatchery Dev Environment

You are running inside a Hatchery drone — a devcontainer managed by Hatchery.

## How credentials work

- Git and GitHub credentials are provided automatically by the **hatchery credential helper**
- The credential helper fetches short-lived tokens from a Unix socket at `/var/run/hatchery-sockets/creds.sock`
- The `gh` CLI is wrapped to automatically use these tokens
- Tokens are scoped to specific repositories via a GitHub App installation

## Critical Rules

- NEVER run `gh auth login`, `gh auth setup-git`, or any `gh auth` commands
- NEVER hardcode tokens or credentials in `.git/config`, `.gitconfig`, or anywhere else
- NEVER modify git credential helper configuration (`git config credential.*`)
- NEVER store tokens in environment variables or files

## Multi-org access

This drone can access repos from **multiple GitHub orgs**. Credentials are routed automatically per org.

### gh CLI

The `gh` wrapper detects the target org automatically:

- From the `--repo` / `-R` flag: `gh pr list --repo cdu-suedniedersachsen/my-repo`
- From the `git remote` of your current directory (if you're inside a repo)

You do NOT need to set `GH_TOKEN` manually. Just use `gh` normally with `--repo org/repo`.

### git clone / push / pull

Works automatically — the credential helper reads which repo git is accessing and fetches the right token for that org.

### Rule: never set GH_TOKEN manually

Do NOT set `GH_TOKEN` in the environment or in scripts. The wrapper handles it. If you hardcode a token it will break other orgs.

## When git authentication fails

If you get a permission error accessing a repository:

1. Do NOT try to fix it yourself — no token hardcoding, no `gh auth`, no workarounds
2. Tell the user: "The hatchery GitHub App does not have access to this repository. Please add the repository to the GitHub App installation permissions."
3. The user needs to update the repository access scope in the GitHub App settings at https://github.com/settings/installations

This applies especially when you can access some repos but not others — it means the token works, but the GitHub App installation is not authorized for that specific repository.
CLAUDEMD
chown -R 1000:1000 "$CLAUDE_DIR"

# Set CLAUDE_CONFIG_DIR for all sessions
echo 'export CLAUDE_CONFIG_DIR=/workspaces/worktrees/.claude' > /etc/profile.d/claude-config.sh

# --- git credential helper (GitHub) ---
cat > /usr/local/bin/git-credential-hatchery <<'CRED'
#!/bin/sh
case "$1" in
  get)
    REPO=""
    while IFS= read -r line && [ -n "$line" ]; do
      case "$line" in
        path=*) REPO="${line#path=}"; REPO="${REPO%.git}" ;;
      esac
    done
    if [ -n "$REPO" ]; then
      T=$(curl -sf --unix-socket /var/run/hatchery-sockets/creds.sock "http://localhost/token?repo=${REPO}")
    else
      T=$(curl -sf --unix-socket /var/run/hatchery-sockets/creds.sock http://localhost/token)
    fi
    [ -z "$T" ] && exit 1
    echo "protocol=https"
    echo "host=github.com"
    echo "username=x-access-token"
    echo "password=$T"
    ;;
esac
CRED
chmod +x /usr/local/bin/git-credential-hatchery
git config --system credential.https://github.com.helper /usr/local/bin/git-credential-hatchery
git config --system url."https://github.com/".insteadOf "git@github.com:"

# --- git credential helper (Forgejo) ---
# Reads fake token from file (persisted by postStartCommand)
cat > /usr/local/bin/git-credential-hatchery-forgejo <<'CRED'
#!/bin/sh
case "$1" in
  get)
    TOKEN_FILE="/var/run/hatchery-sockets/.forgejo-token"
    [ -f "$TOKEN_FILE" ] || exit 1
    T=$(cat "$TOKEN_FILE")
    [ -z "$T" ] && exit 1
    echo "protocol=http"
    echo "host=localhost:9998"
    echo "username=hatchery"
    echo "password=$T"
    ;;
esac
CRED
chmod +x /usr/local/bin/git-credential-hatchery-forgejo

# --- gh wrapper ---
if command -v gh >/dev/null 2>&1; then
  GH_REAL=$(command -v gh)
  cp "$GH_REAL" /usr/bin/gh-real
  cat > /usr/local/bin/gh <<'GH'
#!/bin/sh
# Detect target org from --repo/-R flag or git remote
ORG=""
PREV=""
for arg in "$@"; do
  case "$PREV" in
    --repo|-R)
      ORG="${arg%%/*}"
      ;;
  esac
  PREV="$arg"
done
if [ -z "$ORG" ]; then
  REMOTE=$(git remote get-url origin 2>/dev/null)
  case "$REMOTE" in
    https://github.com/*)
      REPO_PATH="${REMOTE#https://github.com/}"
      ORG="${REPO_PATH%%/*}"
      ;;
  esac
fi
if [ -n "$ORG" ]; then
  GH_TOKEN=$(curl -s --unix-socket /var/run/hatchery-sockets/creds.sock "http://localhost/token?org=${ORG}")
else
  GH_TOKEN=$(curl -s --unix-socket /var/run/hatchery-sockets/creds.sock http://localhost/token)
fi
export GH_TOKEN
exec /usr/bin/gh-real "$@"
GH
  chmod +x /usr/local/bin/gh
fi

# --- tea CLI wrapper (Forgejo) ---
cat > /usr/local/bin/tea-hatchery-wrapper <<'TEA'
#!/bin/sh
TOKEN_FILE="/var/run/hatchery-sockets/.forgejo-token"
if [ -f "$TOKEN_FILE" ]; then
  export GITEA_URL="http://localhost:9998"
  export GITEA_TOKEN=$(cat "$TOKEN_FILE")
fi
# Find real tea binary
REAL_TEA=""
for p in /usr/bin/tea /usr/local/bin/tea-real; do
  [ -x "$p" ] && REAL_TEA="$p" && break
done
[ -z "$REAL_TEA" ] && echo "tea not found" && exit 1
exec "$REAL_TEA" "$@"
TEA
chmod +x /usr/local/bin/tea-hatchery-wrapper

# --- socat for TCP→Unix socket bridge (Forgejo) ---
apt-get update -qq && apt-get install -y -qq socat mosh locales > /dev/null 2>&1
sed -i 's/# en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen && locale-gen > /dev/null 2>&1
echo 'LANG=en_US.UTF-8' > /etc/default/locale
echo 'export LANG=en_US.UTF-8' >> /etc/profile.d/locale.sh

# --- postStartCommand entrypoint ---
cat > /usr/local/bin/hatchery-post-start <<'POST'
#!/bin/sh
# Note: no set -e — individual steps log errors but never abort the drone setup.

# Install global SSH host key (shared across all drones, never changes)
GLOBAL_HOST_KEY="/var/run/hatchery-host-key"
if [ -f "$GLOBAL_HOST_KEY" ]; then
  sudo cp "$GLOBAL_HOST_KEY" /etc/ssh/ssh_host_ed25519_key || true
  sudo ssh-keygen -y -f "$GLOBAL_HOST_KEY" | sudo tee /etc/ssh/ssh_host_ed25519_key.pub > /dev/null || true
  sudo chmod 600 /etc/ssh/ssh_host_ed25519_key || true
  sudo chmod 644 /etc/ssh/ssh_host_ed25519_key.pub || true
  sudo pkill -HUP sshd || true
fi

# SSH keys from GitHub
if [ -n "$HATCHERY_GITHUB_USER" ]; then
  USER_HOME=$(getent passwd 1000 | cut -d: -f6)
  mkdir -p "$USER_HOME/.ssh"
  chmod 700 "$USER_HOME/.ssh"
  curl -fsSL "https://github.com/${HATCHERY_GITHUB_USER}.keys" >> "$USER_HOME/.ssh/authorized_keys" || true
  chmod 600 "$USER_HOME/.ssh/authorized_keys" || true
  chown -R 1000:1000 "$USER_HOME/.ssh" || true
fi

# Tailscale / Headscale join
# We persist the machine state in the socket dir so that after slay+respawn
# Headscale sees the same machine key and keeps the hostname (no random suffix).
if [ -n "$HATCHERY_TS_AUTH_KEY" ]; then
  TAILSCALE_CACHE="/var/run/hatchery-sockets/.tailscale"

  if [ -d "$TAILSCALE_CACHE" ] && [ "$(ls -A "$TAILSCALE_CACHE" 2>/dev/null)" ]; then
    # Restore persisted state: stop daemon, replace state, restart daemon
    sudo pkill tailscaled 2>/dev/null || true
    sleep 1
    sudo cp -a "$TAILSCALE_CACHE/." /var/lib/tailscale/
    sudo chown -R root:root /var/lib/tailscale/
    sudo mkdir -p /var/run/tailscale
    nohup sudo tailscaled \
      --state=/var/lib/tailscale/tailscaled.state \
      --socket=/var/run/tailscale/tailscaled.sock \
      >/tmp/tailscaled.log 2>&1 &
    sleep 2
  fi

  sudo tailscale up \
    --login-server="$HATCHERY_TS_LOGIN_SERVER" \
    --authkey="$HATCHERY_TS_AUTH_KEY" \
    --hostname="$HATCHERY_TS_HOSTNAME" || echo "WARNING: tailscale up failed — drone may not be reachable via Tailscale"

  # Tailscale's ts-input chain drops all inbound tailnet traffic (100.64.0.0/10) by default.
  # Poll until the chain appears (tailscaled adds it asynchronously after tailscale up).
  # Then insert an ACCEPT rule before the DROP so peers can reach SSH on port 2222.
  for _i in $(seq 1 15); do
    RULE_NUM=$(iptables -L ts-input -n --line-numbers 2>/dev/null | awk '/DROP.*100\.64\.0\.0\/10/{print $1; exit}')
    [ -n "$RULE_NUM" ] && break
    sleep 1
  done
  if [ -n "$RULE_NUM" ]; then
    iptables -I ts-input "$RULE_NUM" -p tcp --dport 2222 -s 100.64.0.0/10 -j ACCEPT 2>/dev/null || true
  fi

  # Persist state for next spawn (socket dir is bind-mounted from host, survives slay)
  mkdir -p "$TAILSCALE_CACHE" || true
  sudo cp -a /var/lib/tailscale/. "$TAILSCALE_CACHE/" || true
  sudo chown -R 1000:1000 "$TAILSCALE_CACHE/" || true
fi

# --- Forgejo provider setup ---
if [ "$HATCHERY_PROVIDER" = "forgejo" ] && [ -n "$HATCHERY_FORGEJO_HOST" ]; then
  # Persist fake token to file so credential helper and tea wrapper can read it
  echo -n "$HATCHERY_FORGEJO_FAKE_TOKEN" > /var/run/hatchery-sockets/.forgejo-token
  chmod 644 /var/run/hatchery-sockets/.forgejo-token

  # Persist env vars for SSH sessions
  sudo tee /etc/profile.d/hatchery-forgejo.sh > /dev/null <<ENVEOF
export HATCHERY_PROVIDER=forgejo
export HATCHERY_FORGEJO_HOST=${HATCHERY_FORGEJO_HOST}
export HATCHERY_FORGEJO_FAKE_TOKEN=${HATCHERY_FORGEJO_FAKE_TOKEN}
ENVEOF

  # Start TCP→Unix socket bridge for the proxy
  nohup socat TCP-LISTEN:9998,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/var/run/hatchery-sockets/proxy.sock > /tmp/hatchery-bridge.log 2>&1 &

  # Configure git credential helper for the proxy
  sudo git config --system credential.http://localhost:9998.helper /usr/local/bin/git-credential-hatchery-forgejo

  # URL rewrites: redirect Forgejo HTTPS and SSH URLs to local proxy
  # Unset first to be idempotent (postStartCommand runs on every container start)
  sudo git config --system --unset-all "url.http://localhost:9998/.insteadOf" 2>/dev/null || true
  sudo git config --system "url.http://localhost:9998/.insteadOf" "https://${HATCHERY_FORGEJO_HOST}/"
  sudo git config --system --add "url.http://localhost:9998/.insteadOf" "git@${HATCHERY_FORGEJO_HOST}:"

  # Set up tea wrapper if tea is installed
  if command -v tea >/dev/null 2>&1; then
    TEA_REAL=$(command -v tea)
    cp "$TEA_REAL" /usr/local/bin/tea-real 2>/dev/null || true
    ln -sf /usr/local/bin/tea-hatchery-wrapper "$(dirname "$TEA_REAL")/tea" 2>/dev/null || true
  fi
fi
POST
chmod +x /usr/local/bin/hatchery-post-start
