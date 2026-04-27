#!/bin/bash
# Integration test: spawn a drone, verify SSH + Tailscale, test hostname stability on respawn.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEST_REPO="$REPO_ROOT/test-repo"
HEADSCALE_IMAGE="headscale/headscale:0.23.0-alpha12"
HEADSCALE_CONTAINER="hatchery-test-headscale"
DRONE_NAME="hatchery-test-repo"

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

pass() { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; exit 1; }
info() { echo -e "${YELLOW}→${NC} $1"; }

cleanup() {
  info "Cleaning up..."
  docker ps --filter "label=hatchery.drone=$DRONE_NAME" -q | xargs -r docker rm -f 2>/dev/null || true
  sudo rm -rf "$HOME/.hatchery/sockets/$DRONE_NAME" 2>/dev/null || rm -rf "$HOME/.hatchery/sockets/$DRONE_NAME" 2>/dev/null || true
  docker rm -f "$HEADSCALE_CONTAINER" 2>/dev/null || true
  docker volume rm hatchery-test-headscale-data 2>/dev/null || true
  [ -f "$REPO_ROOT/config.json.test-bak" ] && mv "$REPO_ROOT/config.json.test-bak" "$REPO_ROOT/config.json" || true
}
trap cleanup EXIT

cd "$REPO_ROOT"

# ── Pre-flight: remove any leftovers from previous runs ──────────────────────
docker ps --filter "label=hatchery.drone=$DRONE_NAME" -q | xargs -r docker rm -f 2>/dev/null || true
docker rm -f "$HEADSCALE_CONTAINER" 2>/dev/null || true
docker volume rm hatchery-test-headscale-data 2>/dev/null || true

# ── 0. Minimal config.json for CI (no GitHub App needed for spawn test) ──────
if [ -f config.json ]; then
  cp config.json config.json.test-bak
fi
cat > config.json <<'EOF'
{
  "installations": {
    "test": "0"
  }
}
EOF

# ── 1. Start Headscale ───────────────────────────────────────────────────────
info "Starting Headscale..."
docker volume create hatchery-test-headscale-data >/dev/null
docker run -d \
  --name "$HEADSCALE_CONTAINER" \
  --network=host \
  --volume hatchery-test-headscale-data:/var/lib/headscale \
  --volume "$SCRIPT_DIR/headscale.yaml:/etc/headscale/config.yaml:ro" \
  "$HEADSCALE_IMAGE" serve >/dev/null 2>&1

for i in $(seq 1 30); do
  if curl -sf http://localhost:8080/health >/dev/null 2>&1; then break; fi
  [ "$i" -eq 30 ] && fail "Headscale did not start in 30s"
  sleep 1
done
pass "Headscale running"

# ── 2. Create user + reusable pre-auth key ───────────────────────────────────
info "Creating Headscale user and pre-auth key..."
docker exec "$HEADSCALE_CONTAINER" headscale users create hatchery >/dev/null
AUTH_KEY=$(docker exec "$HEADSCALE_CONTAINER" \
  headscale preauthkeys create --user hatchery --reusable --output json \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['key'])")
[ -n "$AUTH_KEY" ] || fail "Failed to create pre-auth key"
pass "Auth key created: ${AUTH_KEY:0:8}..."

# ── 3. Determine Headscale URL reachable from inside drone containers ─────────
# Headscale runs with --network=host, so it's on the host at port 8080.
# Docker bridge gateway (172.17.0.1) is how containers reach the host.
DOCKER_GW=$(docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')
TS_LOGIN_SERVER="http://${DOCKER_GW}:8080"
info "Headscale URL for containers: $TS_LOGIN_SERVER"

# ── 4. Export hatchery env vars ───────────────────────────────────────────────
export HATCHERY_HEADSCALE_AUTH_KEY="$AUTH_KEY"
export HATCHERY_TAILSCALE_DOMAIN="$TS_LOGIN_SERVER"   # starts with http → no https:// prefix added
export HATCHERY_GITHUB_USER=""
export HATCHERY_DOTFILES_REPO=""
export HATCHERY_GITHUB_CLIENT_ID="test"
export HATCHERY_GITHUB_APP_KEY="test"
export HATCHERY_LOCAL_FEATURE="$REPO_ROOT/features/hatchery"

# ── 5. First spawn ───────────────────────────────────────────────────────────
info "Spawning drone (first time)..."
node --experimental-strip-types src/cli.ts spawn "$TEST_REPO" 2>&1 | grep -v '^\[20' || true

CONTAINER_ID=$(docker ps --filter "label=hatchery.drone=$DRONE_NAME" -q)
[ -n "$CONTAINER_ID" ] || fail "Drone container not found after first spawn"
pass "Drone spawned: $CONTAINER_ID"

# ── 6. Verify sshd is running ────────────────────────────────────────────────
docker exec "$CONTAINER_ID" pgrep sshd >/dev/null || fail "sshd not running"
pass "sshd running"

# ── 7. Verify Tailscale hostname (no suffix) ─────────────────────────────────
info "Checking Tailscale hostname..."
# Give tailscale a moment to fully register
sleep 3
TS_SELF=$(docker exec "$CONTAINER_ID" tailscale status --self 2>&1 | head -1 || true)
info "tailscale status: $TS_SELF"
ACTUAL_HOST=$(echo "$TS_SELF" | awk '{print $2}')
[ "$ACTUAL_HOST" = "$DRONE_NAME" ] || fail "Expected hostname '$DRONE_NAME', got '$ACTUAL_HOST'"
pass "Tailscale hostname correct: $DRONE_NAME"

# ── 8. Slay ──────────────────────────────────────────────────────────────────
info "Slaying drone..."
node --experimental-strip-types src/cli.ts slay "$TEST_REPO" 2>&1 | grep -v '^\[20' || true
docker ps --filter "label=hatchery.drone=$DRONE_NAME" -q | grep -q . && fail "Container still running after slay"
pass "Drone slayed"

# ── 9. Respawn ───────────────────────────────────────────────────────────────
info "Respawning drone..."
node --experimental-strip-types src/cli.ts spawn "$TEST_REPO" 2>&1 | grep -v '^\[20' || true

CONTAINER_ID2=$(docker ps --filter "label=hatchery.drone=$DRONE_NAME" -q)
[ -n "$CONTAINER_ID2" ] || fail "Drone container not found after respawn"
pass "Drone respawned: $CONTAINER_ID2"

# ── 10. Verify hostname unchanged after respawn (regression test) ─────────────
info "Checking Tailscale hostname after respawn..."
sleep 3
TS_SELF2=$(docker exec "$CONTAINER_ID2" tailscale status --self 2>&1 | head -1 || true)
info "tailscale status: $TS_SELF2"
ACTUAL_HOST2=$(echo "$TS_SELF2" | awk '{print $2}')
[ "$ACTUAL_HOST2" = "$DRONE_NAME" ] || fail "Hostname changed after respawn! Got '$ACTUAL_HOST2' (suffix regression)"
pass "Hostname stable after respawn: $DRONE_NAME"

echo ""
echo -e "${GREEN}All tests passed.${NC}"
