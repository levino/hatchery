#!/bin/sh
set -e

# --- git credential helper ---
cat > /usr/local/bin/git-credential-hatchery <<'CRED'
#!/bin/sh
case "$1" in
  get)
    T=$(curl -sf --unix-socket /var/run/github-creds.sock http://localhost/token)
    [ -z "$T" ] && exit 1
    echo "protocol=https"
    echo "host=github.com"
    echo "username=x-access-token"
    echo "password=$T"
    ;;
esac
CRED
chmod +x /usr/local/bin/git-credential-hatchery
git config --system credential.helper /usr/local/bin/git-credential-hatchery
git config --system url."https://github.com/".insteadOf "git@github.com:"

# --- gh wrapper ---
if command -v gh >/dev/null 2>&1; then
  GH_REAL=$(command -v gh)
  cp "$GH_REAL" /usr/bin/gh-real
  cat > /usr/local/bin/gh <<'GH'
#!/bin/sh
export GH_TOKEN=$(curl -s --unix-socket /var/run/github-creds.sock http://localhost/token)
exec /usr/bin/gh-real "$@"
GH
  chmod +x /usr/local/bin/gh
fi

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
POST
chmod +x /usr/local/bin/hatchery-post-start
