#!/bin/sh
# Runs a fast local Symbio development stack with bind-mounted source and Node
# watch restarts, without changing the real-VM deployment workflow.
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CONFIG_DIR="${SYMBIO_LOCAL_CONFIG_DIR:-${DIR}/.symbio}"
if [ "$#" -eq 0 ]; then set -- start; fi
COMMAND="$1"

# Routes every operation through the production Compose file plus local-only
# source mounts so runtime security settings remain representative.
compose() {
  SYMBIO_CONFIG_DIR="$CONFIG_DIR" docker compose \
    -f "$DIR/compose.yaml" \
    -f "$DIR/compose.local.yaml" \
    "$@"
}

# Lists commands without hiding which operations retain or destroy local data.
usage() {
  cat <<'USAGE'
Usage: ./deploy-local.sh [command]

Commands:
  start     Start local development containers (default).
  restart   Restart both containers without rebuilding images.
  rebuild   Rebuild images, recreate containers, and retain databases.
  seed      Run migrations and create a superadmin if needed.
  logs      Follow mothership and agent logs.
  status    Show container and agent status.
  stop      Stop containers while retaining databases.
  reset     Delete local databases and recreate the development stack.
  help      Show this message.
USAGE
}

# Fails before creating local state when a required debugging tool is absent.
check_prerequisites() {
  for command in curl docker openssl; do
    if ! command -v "$command" >/dev/null 2>&1; then
      printf 'Missing local prerequisite: %s\n' "$command" >&2
      exit 1
    fi
  done
  if ! docker info >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    echo "A running Docker Engine with Compose v2 is required." >&2
    exit 1
  fi
}

# Creates the shared token with the same host/container permission boundary as
# the installer: protected directory on the host, readable read-only bind file.
ensure_token() {
  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"
  if [ ! -s "$CONFIG_DIR/agent-token" ]; then
    umask 077
    openssl rand -hex 32 >"$CONFIG_DIR/agent-token"
  fi
  chmod 444 "$CONFIG_DIR/agent-token"
}

# Builds only when either required image is absent; source changes normally use
# bind mounts and therefore do not need another Docker build.
ensure_images() {
  if ! docker image inspect symbio-mothership:beta >/dev/null 2>&1 \
    || ! docker image inspect symbio-agent:beta >/dev/null 2>&1; then
    compose build
  fi
}

# Initializes a new data volume interactively and otherwise leaves existing
# users and monitoring history untouched.
initialize_fresh_data() {
  if ! docker volume inspect symbio-mothership-data >/dev/null 2>&1; then
    compose run --rm --no-deps mothership npm run migrate
    compose run --rm --no-deps mothership npm run seed:superadmin
  fi
}

# Waits for both real health checks and prints logs immediately on failure.
wait_for_health() {
  attempt=0
  while [ "$attempt" -lt 30 ]; do
    mothership_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' symbio-mothership 2>/dev/null || true)
    agent_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' symbio-agent 2>/dev/null || true)
    if [ "$mothership_health" = "healthy" ] && [ "$agent_health" = "healthy" ]; then return 0; fi
    attempt=$((attempt + 1))
    sleep 1
  done
  compose ps
  compose logs --no-color --tail=150
  echo "Local Symbio containers did not become healthy." >&2
  return 1
}

# Confirms the worker reached the mothership after startup; agent HTTP health
# alone would remain green while reports were only accumulating in the outbox.
wait_for_agent_delivery() {
  attempt=0
  while [ "$attempt" -lt 20 ]; do
    status=$(curl -fsS "http://127.0.0.1:${SYMBIO_AGENT_HEALTH_PORT:-18767}/api/v1/status" 2>/dev/null || true)
    if printf '%s' "$status" | grep -q '"outboxCount":0' \
      && printf '%s' "$status" | grep -Eq '"lastDeliveryAt":"[^"]+"' \
      && printf '%s' "$status" | grep -q '"lastError":null'; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  printf 'Agent did not deliver a report successfully. Last status: %s\n' "$status" >&2
  return 1
}

# Starts or recreates the stack and reports the fixed local debugging URLs.
start_stack() {
  compose up -d "$@"
  wait_for_health
  wait_for_agent_delivery
  compose ps
  printf '\nDashboard: http://127.0.0.1:%s\n' "${SYMBIO_PORT:-8765}"
  printf 'Agent status: http://127.0.0.1:%s/api/v1/status\n' "${SYMBIO_AGENT_HEALTH_PORT:-18767}"
  printf 'Follow logs: ./deploy-local.sh logs\n'
  printf 'Manual restart: ./deploy-local.sh restart\n'
}

case "$COMMAND" in
  help|-h|--help) usage; exit 0 ;;
  start|restart|rebuild|seed|logs|status|stop|reset) ;;
  *) printf 'Unknown command: %s\n' "$COMMAND" >&2; usage >&2; exit 2 ;;
esac
check_prerequisites

case "$COMMAND" in
  start)
    test "$#" -eq 1 || { usage >&2; exit 2; }
    ensure_token
    ensure_images
    initialize_fresh_data
    start_stack
    ;;
  restart)
    test "$#" -eq 1 || { usage >&2; exit 2; }
    ensure_token
    # A Docker restart does not apply changed Compose environment, mounts, or
    # networks. Recreate is still fast with source binds and keeps named data.
    start_stack --force-recreate
    ;;
  rebuild)
    test "$#" -eq 1 || { usage >&2; exit 2; }
    ensure_token
    compose build
    initialize_fresh_data
    start_stack --force-recreate
    ;;
  seed)
    test "$#" -eq 1 || { usage >&2; exit 2; }
    ensure_token
    ensure_images
    compose run --rm --no-deps mothership npm run migrate
    compose run --rm --no-deps mothership npm run seed:superadmin
    ;;
  logs)
    test "$#" -eq 1 || { usage >&2; exit 2; }
    compose logs --follow --tail=150 mothership agent
    ;;
  status)
    test "$#" -eq 1 || { usage >&2; exit 2; }
    compose ps
    if docker inspect symbio-agent >/dev/null 2>&1; then
      curl -fsS "http://127.0.0.1:${SYMBIO_AGENT_HEALTH_PORT:-18767}/api/v1/status"
      printf '\n'
    fi
    ;;
  stop)
    test "$#" -eq 1 || { usage >&2; exit 2; }
    compose down --remove-orphans
    ;;
  reset)
    test "$#" -eq 1 || { usage >&2; exit 2; }
    ensure_token
    ensure_images
    compose down -v --remove-orphans
    initialize_fresh_data
    start_stack
    ;;
esac
