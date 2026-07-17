#!/bin/sh
# Symbio single-command installer — builds containers, seeds superadmin, shows URL.

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# ── Remote mode ─────────────────────────────────────────────────────

if [ ! -f "${DIR}/compose.yaml" ]; then
  [ -n "${SOURCE_SERVER:-}" ] || { echo "ERROR: pipe from install server."; exit 1; }
  TMPDIR=$(mktemp -d /tmp/symbio-install-XXXXXX)
  trap 'rm -rf "$TMPDIR"' EXIT INT TERM
  printf '\033[1;34m[Symbio]\033[0m Downloading source...\n' >&2
  curl -fsSL "${SOURCE_SERVER}/source.tar.gz" -o "${TMPDIR}/source.tar.gz" || exit 1
  printf '\033[1;34m[Symbio]\033[0m Extracting...\n' >&2
  tar -xzf "${TMPDIR}/source.tar.gz" -C "$TMPDIR"
  DIR="$TMPDIR"; cd "$DIR"
  docker ps -a --filter ancestor=symbio-mothership:beta -q | xargs -r docker rm -f 2>/dev/null || true
  docker ps -a --filter ancestor=symbio-agent:beta -q | xargs -r docker rm -f 2>/dev/null || true
  docker volume rm symbio-mothership-data symbio-agent-data 2>/dev/null || true
fi

# ── helpers ──────────────────────────────────────────────────────────

msg() { printf '\033[1;34m[Symbio]\033[0m %s\n' "$*" >&2; }
ok()  { printf '\033[1;32m[Symbio] \342\234\223\033[0m %s\n' "$*" >&2; }
err() { printf '\033[1;31m[Symbio] \342\234\227\033[0m %s\n' "$*" >&2; exit 1; }

trap 'printf "\n" >&2; err "Installation cancelled."' INT TERM

# ── Pre-flight: check compose ───────────────────────────────────────

docker compose version >/dev/null 2>&1 || err "Docker Compose v2 (docker compose) required."

# ─── Collect configuration ──────────────────────────────────────────

PORT="${SYMBIO_PORT:-}"
SEED_USERNAME=""; SEED_DISPLAY=""; SEED_EMAIL=""; SEED_PASSWORD=""; DO_SEED=0

TTY_OK=0
# Interactive when /dev/tty is accessible (works for curl | bash too)
[ -c /dev/tty ] 2>/dev/null && TTY_OK=1

if [ "$TTY_OK" -eq 1 ]; then
  # ── Interactive mode: retry loops on every prompt ──────────────────

  # Port
  while :; do
    printf '\n\033[1m>>>\033[0m Port for dashboard? (default 8765): ' >&2
    read -r P </dev/tty || P=""
    [ -z "$P" ] && P=8765
    case "$P" in
      ''|*[!0-9]*) msg "Invalid port. Enter a number (1-65535)." ;;
      *) [ "$P" -ge 1 ] 2>/dev/null && [ "$P" -le 65535 ] 2>/dev/null && break
         msg "Port out of range (1-65535)." ;;
    esac
  done
  PORT=$P

  # Superadmin choice
  while :; do
    printf '\n\033[1m>>>\033[0m Create superadmin account? (Y/n): ' >&2
    read -r S </dev/tty || S="y"
    case "$S" in
      y|Y|yes|YES|"") DO_SEED=1; break ;;
      n|N|no|NO)      DO_SEED=0; break ;;
      *)              msg "Please answer Y or n." ;;
    esac
  done

  if [ "$DO_SEED" -eq 1 ]; then
    printf '\n  \033[1mCreate your admin account\033[0m\n' >&2

    while :; do
      printf '  Username: ' >&2; read -r SEED_USERNAME </dev/tty || SEED_USERNAME=""
      [ -n "$SEED_USERNAME" ] && break
      msg "Username cannot be empty."
    done

    printf '  Display name (default: Administrator): ' >&2
    read -r SEED_DISPLAY </dev/tty || SEED_DISPLAY=""
    [ -z "$SEED_DISPLAY" ] && SEED_DISPLAY="Administrator"

    while :; do
      printf '  Email: ' >&2; read -r SEED_EMAIL </dev/tty || SEED_EMAIL=""
      case "$SEED_EMAIL" in
        *@*) break ;;
        *)   msg "Email must contain @." ;;
      esac
    done

    while :; do
      printf '  Password (min 8 chars): ' >&2; read -r SEED_PASSWORD </dev/tty || SEED_PASSWORD=""
      case "$SEED_PASSWORD" in
        ????????*) break ;;
        *) msg "Password must be at least 8 characters." ;;
      esac
    done

    while :; do
      printf '  Confirm: ' >&2; read -r SC </dev/tty || SC=""
      [ "$SEED_PASSWORD" = "$SC" ] && break
      msg "Passwords do not match."
    done
  fi
else
  # ── Non-interactive mode: read from env vars ────────────────────
  PORT="${SYMBIO_PORT:-8765}"
  if [ -n "${SYMBIO_SEED_USERNAME:-}" ]; then
    DO_SEED=1
    SEED_USERNAME="$SYMBIO_SEED_USERNAME"
    SEED_DISPLAY="${SYMBIO_SEED_DISPLAY_NAME:-Administrator}"
    SEED_EMAIL="${SYMBIO_SEED_EMAIL:-}"
    SEED_PASSWORD="${SYMBIO_SEED_PASSWORD:-}"
    [ -n "$SEED_EMAIL" ]    || err "SYMBIO_SEED_EMAIL required."
    [ -n "$SEED_PASSWORD" ] || err "SYMBIO_SEED_PASSWORD required."
  fi
fi

msg "Dashboard: http://127.0.0.1:${PORT}"
[ "$DO_SEED" -eq 1 ] && msg "Admin: ${SEED_USERNAME} <${SEED_EMAIL}>"

# ─── Write config ────────────────────────────────────────────────────

CONFIG_DIR="${DIR}/.symbio"
LOG_FILE="${DIR}/install.log"
if [ -s "$CONFIG_DIR/agent-token" ]; then
  ok "Reusing agent token"
else
  mkdir -p "$CONFIG_DIR" && chmod 700 "$CONFIG_DIR"
  dd if=/dev/urandom bs=32 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n' >"$CONFIG_DIR/agent-token"
  chmod 444 "$CONFIG_DIR/agent-token"
  ok "Agent token created"
fi

BRIDGE_IP=$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || echo "172.17.0.1")
ADM_GID=$(getent group adm 2>/dev/null | awk -F: '{print $3}' || echo 4)
DOCKER_GID=$(getent group docker 2>/dev/null | awk -F: '{print $3}' || echo 998)
SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "")

cat > "${DIR}/.env" <<EOF
SYMBIO_CONFIG_DIR=${CONFIG_DIR}
SYMBIO_PORT=${PORT}
SYMBIO_BIND_IP=0.0.0.0
SYMBIO_INTERNAL_PORT=18766
SYMBIO_AGENT_HEALTH_PORT=18767
SYMBIO_AGENT_BRIDGE_IP=${BRIDGE_IP}
SYMBIO_AGENT_LOG_GROUP_GID=${ADM_GID}
SYMBIO_DOCKER_GROUP_GID=${DOCKER_GID}
SYMBIO_SERVER_IP=${SERVER_IP}
EOF
chmod 600 "${DIR}/.env"
ok "Configuration written"

# ─── Build ───────────────────────────────────────────────────────────

msg "Building containers..."
cd "$DIR" || err "Cannot enter install directory"
if ! docker compose build > "$LOG_FILE" 2>&1; then
  tail -20 "$LOG_FILE" >&2
  err "Build failed. See ${LOG_FILE}"
fi
ok "Build complete"

# ─── Start ───────────────────────────────────────────────────────────

msg "Starting containers..."
docker compose up -d || err "Failed to start containers."

msg "Waiting for services..."
ATTEMPT=0
while [ "$ATTEMPT" -lt 30 ]; do
  M=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' symbio-mothership 2>/dev/null || echo "")
  A=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' symbio-agent 2>/dev/null || echo "")
  [ "$M" = "healthy" ] && [ "$A" = "healthy" ] && break
  ATTEMPT=$((ATTEMPT + 1))
  sleep 2
done
[ "$M" = "healthy" ] && [ "$A" = "healthy" ] || err "Containers did not become healthy."

# ─── Migrate ─────────────────────────────────────────────────────────

msg "Running database migrations..."
docker exec -i symbio-mothership npm run migrate < /dev/null || err "Migration failed."
ok "Migrations applied"

# ─── Seed ────────────────────────────────────────────────────────────

if [ "$DO_SEED" -eq 1 ]; then
  msg "Creating admin account..."
  envf=$(mktemp /tmp/symbio-seed.XXXXXX) || err "Cannot create temp file"
  # printf %s is safe for any value — newlines, special chars, etc.
  printf 'SYMBIO_SEED_USERNAME=%s\n'         "$SEED_USERNAME"  > "$envf"
  printf 'SYMBIO_SEED_DISPLAY_NAME=%s\n'     "$SEED_DISPLAY"   >> "$envf"
  printf 'SYMBIO_SEED_EMAIL=%s\n'            "$SEED_EMAIL"     >> "$envf"
  printf 'SYMBIO_SEED_PASSWORD=%s\n'         "$SEED_PASSWORD"  >> "$envf"
  printf 'SYMBIO_SEED_PASSWORD_CONFIRM=%s\n' "$SEED_PASSWORD"  >> "$envf"

  # Pipe env file bytes directly into Node.js (avoids shell expansion of
  # special characters like $, !, ` in password values). Node reads from
  # stdin, sets process.env literally, then imports the seed script.
  docker exec -i symbio-mothership node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const text = readFileSync("/dev/stdin", "utf8");
    for (const line of text.split("\n").filter(Boolean)) {
      const idx = line.indexOf("=");
      if (idx > 0) process.env[line.slice(0, idx)] = line.slice(idx + 1);
    }
    await import("./scripts/seed-superadmin.js");
  ' < "$envf"
  rc=$?
  rm -f "$envf"
  [ $rc -eq 0 ] || err "Superadmin creation failed."
  ok "Admin ${SEED_USERNAME} created"
fi

# ─── Done ────────────────────────────────────────────────────────────

printf '\n'
printf '  \033[1;34m╔══════════════════════════════════════════════════╗\033[0m\n'
printf '  \033[1;34m║\033[0m              \033[1mSymbio is ready\033[0m                      \033[1;34m║\033[0m\n'
printf '  \033[1;34m║\033[0m                                              \033[1;34m║\033[0m\n'
printf '  \033[1;34m║\033[0m  Open:  \033[1mhttp://127.0.0.1:%s\033[0m                \033[1;34m║\033[0m\n' "${PORT}"
[ -n "$SERVER_IP" ] && printf '  \033[1;34m║\033[0m         \033[1mhttp://%s:%s\033[0m                     \033[1;34m║\033[0m\n' "${SERVER_IP}" "${PORT}"
printf '  \033[1;34m║\033[0m                                              \033[1;34m║\033[0m\n'
[ "$DO_SEED" -eq 1 ] && printf '  \033[1;34m║\033[0m  Admin:  \033[1m%s\033[0m (\033[2m%s\033[0m)               \033[1;34m║\033[0m\n' "${SEED_USERNAME}" "${SEED_EMAIL}"
printf '  \033[1;34m║\033[0m                                              \033[1;34m║\033[0m\n'
printf '  \033[1;34m║\033[0m  Run the Setup Wizard to finish config.    \033[1;34m║\033[0m\n'
printf '  \033[1;34m║\033[0m                                              \033[1;34m║\033[0m\n'
printf '  \033[1;34m║\033[0m  \033[2mStop:\033[0m  docker compose -p symbio down          \033[1;34m║\033[0m\n'
printf '  \033[1;34m║\033[0m  \033[2mLogs:\033[0m  docker compose -p symbio logs -f       \033[1;34m║\033[0m\n'
printf '  \033[1;34m╚══════════════════════════════════════════════════╝\033[0m\n'
printf '\n'
