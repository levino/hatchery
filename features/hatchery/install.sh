#!/bin/sh
set -e

# --- git credential helper (GitHub) ---
cat > /usr/local/bin/git-credential-hatchery <<'CRED'
#!/bin/sh
case "$1" in
  get)
    T=$(curl -sf --unix-socket /var/run/hatchery-sockets/creds.sock http://localhost/token)
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
export GH_TOKEN=$(curl -s --unix-socket /var/run/hatchery-sockets/creds.sock http://localhost/token)
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

# --- postStartCommand entrypoint ---
cat > /usr/local/bin/hatchery-post-start <<'POST'
#!/bin/sh
set -e

# Persist SSH host keys across rebuilds (volume: /var/lib/hatchery/host-keys)
HOST_KEY_DIR="/var/lib/hatchery/host-keys"
if ls "$HOST_KEY_DIR"/ssh_host_* >/dev/null 2>&1; then
  sudo cp "$HOST_KEY_DIR"/ssh_host_* /etc/ssh/
  sudo chmod 600 /etc/ssh/ssh_host_*_key
  sudo chmod 644 /etc/ssh/ssh_host_*_key.pub
  # Restart sshd so it picks up the restored keys (it already started via entrypoint)
  sudo pkill -HUP sshd || true
else
  sudo cp /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub "$HOST_KEY_DIR/"
fi

# SSH keys from GitHub
if [ -n "$HATCHERY_GITHUB_USER" ]; then
  USER_HOME=$(getent passwd 1000 | cut -d: -f6)
  mkdir -p "$USER_HOME/.ssh"
  chmod 700 "$USER_HOME/.ssh"
  curl -fsSL "https://github.com/${HATCHERY_GITHUB_USER}.keys" >> "$USER_HOME/.ssh/authorized_keys"
  chmod 600 "$USER_HOME/.ssh/authorized_keys"
  chown -R 1000:1000 "$USER_HOME/.ssh"
fi

# Tailscale / Headscale join
if [ -n "$HATCHERY_TS_AUTH_KEY" ]; then
  sudo tailscale up \
    --login-server="$HATCHERY_TS_LOGIN_SERVER" \
    --authkey="$HATCHERY_TS_AUTH_KEY" \
    --hostname="$HATCHERY_TS_HOSTNAME"
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
