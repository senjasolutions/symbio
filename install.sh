#!/bin/sh
# Symbio Beta installer performs a fresh, rollback-capable source build on supported Ubuntu hosts.
set -eu

INSTALL_DIR="${SYMBIO_INSTALL_DIR:-/opt/symbio}"
CONFIG_DIR="${SYMBIO_CONFIG_DIR:-/etc/symbio}"
LOG_DIR="${SYMBIO_LOG_DIR:-/var/log/symbio}"
LOG_FILE="${LOG_DIR}/install.log"
REPOSITORY="${SYMBIO_REPOSITORY:-https://github.com/senjasolutions/symbio.git}"
SOURCE_DIR="${SYMBIO_SOURCE_DIR:-}"
SKIP_BUILD="${SYMBIO_SKIP_BUILD:-0}"
REUSE_DATA="${SYMBIO_REUSE_DATA:-0}"
DEPLOY_ENV_FILE="${SYMBIO_DEPLOY_ENV_FILE:-}"
BIND_IP="${SYMBIO_BIND_IP:-0.0.0.0}"
PUBLIC_PORT="${SYMBIO_PORT:-8765}"
INTERNAL_PORT="${SYMBIO_INTERNAL_PORT:-18766}"
AGENT_HEALTH_PORT="${SYMBIO_AGENT_HEALTH_PORT:-18767}"
AGENT_LOG_READER_PORT="${SYMBIO_AGENT_LOG_READER_PORT:-18768}"
AGENT_BRIDGE_IP="${SYMBIO_AGENT_BRIDGE_IP:-}"
AGENT_LOG_GROUP_GID="${SYMBIO_AGENT_LOG_GROUP_GID:-}"
STAGING_DIR="${INSTALL_DIR}.staging.$$"
INSTALL_STARTED=0

umask 077

if [ "$(id -u)" -ne 0 ]; then
  echo "Symbio installation must run as root."
  exit 1
fi

mkdir -p "${LOG_DIR}"
: >"${LOG_FILE}"

# Prints operator progress while retaining the same redacted message in the install log.
log() {
  printf '%s\n' "$*"
  printf '%s\n' "$*" >>"${LOG_FILE}"
}

# Runs a non-secret command with detailed output in the log and a concise failure message.
run_logged() {
  description="$1"
  shift
  log "${description}"
  if ! "$@" >>"${LOG_FILE}" 2>&1; then
    log "FAILED: ${description}. Review ${LOG_FILE}."
    return 1
  fi
}

# Removes only resources created by this attempt; data-reuse mode must never
# delete preserved credentials or named database volumes during rollback.
rollback() {
  status=$?
  trap - EXIT INT TERM
  if [ "${status}" -eq 0 ]; then return; fi
  log "Installation failed; rolling back newly created Symbio resources."
  if [ "${INSTALL_STARTED}" -eq 1 ] && [ -f "${INSTALL_DIR}/compose.yaml" ]; then
    if [ "${REUSE_DATA}" -eq 1 ]; then
      (cd "${INSTALL_DIR}" && docker compose down --remove-orphans) >>"${LOG_FILE}" 2>&1 || true
    else
      (cd "${INSTALL_DIR}" && docker compose down -v --remove-orphans) >>"${LOG_FILE}" 2>&1 || true
    fi
  fi
  rm -rf "${STAGING_DIR}"
  if [ "${INSTALL_STARTED}" -eq 1 ]; then
    rm -rf "${INSTALL_DIR}"
    if [ "${REUSE_DATA}" -eq 0 ]; then rm -rf "${CONFIG_DIR}"; fi
  fi
  exit "${status}"
}
trap rollback EXIT INT TERM

# Verifies one required executable and stops before changing the server.
require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log "Missing prerequisite: $1"
    exit 1
  fi
}

for command in docker hostname awk od tr; do require_command "${command}"; done
# Normal public installation clones main. The VM test helper supplies a copied
# source directory so it can exercise uncommitted code without creating Git data.
if [ -z "${SOURCE_DIR}" ]; then require_command git; else require_command cp; fi
if [ "${SKIP_BUILD}" != "0" ] && [ "${SKIP_BUILD}" != "1" ]; then
  log "SYMBIO_SKIP_BUILD must be 0 or 1."
  exit 1
fi
if [ "${REUSE_DATA}" != "0" ] && [ "${REUSE_DATA}" != "1" ]; then
  log "SYMBIO_REUSE_DATA must be 0 or 1."
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  log "Docker is installed, but its daemon is not reachable."
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  log "Docker Compose v2 is required (the 'docker compose' command)."
  exit 1
fi

if [ ! -r /etc/os-release ]; then
  log "Cannot identify this operating system. Phase 1 supports Ubuntu only."
  exit 1
fi
. /etc/os-release
case "${ID:-}:${VERSION_ID:-}" in
  ubuntu:22.04|ubuntu:24.04|ubuntu:26.04) ;;
  *) log "Unsupported operating system: ${PRETTY_NAME:-unknown}. Supported: Ubuntu 22.04, 24.04, and 26.04 LTS."; exit 1 ;;
esac
case "$(dpkg --print-architecture 2>/dev/null || uname -m)" in
  amd64|arm64|x86_64|aarch64) ;;
  *) log "Unsupported CPU architecture. Phase 1 supports amd64 and arm64."; exit 1 ;;
esac

if [ -e "${INSTALL_DIR}" ]; then
  log "An existing Symbio application directory was found; nothing was changed."
  exit 1
fi
if [ "${REUSE_DATA}" -eq 1 ]; then
  if [ -z "${SOURCE_DIR}" ]; then
    log "Data-reuse mode is available only with an explicit copied source directory."
    exit 1
  fi
  if [ ! -d "${CONFIG_DIR}" ] || [ ! -s "${CONFIG_DIR}/agent-token" ]; then
    log "Data-reuse mode requires the existing Symbio configuration and agent token."
    exit 1
  fi
else
  if [ -e "${CONFIG_DIR}" ]; then
    log "Existing Symbio configuration was found. Fresh installation did not overwrite it."
    exit 1
  fi
fi
if [ -n "${DEPLOY_ENV_FILE}" ] && [ ! -f "${DEPLOY_ENV_FILE}" ]; then
  log "The preserved deployment environment file does not exist: ${DEPLOY_ENV_FILE}"
  exit 1
fi
# Application-only redeploy keeps previous binding and diagnostic ports. The
# file is installer-generated, root-owned data captured before source removal.
if [ -n "${DEPLOY_ENV_FILE}" ]; then
  . "${DEPLOY_ENV_FILE}"
  BIND_IP="${SYMBIO_BIND_IP:-${BIND_IP}}"
  PUBLIC_PORT="${SYMBIO_PORT:-${PUBLIC_PORT}}"
  INTERNAL_PORT="${SYMBIO_INTERNAL_PORT:-${INTERNAL_PORT}}"
  AGENT_HEALTH_PORT="${SYMBIO_AGENT_HEALTH_PORT:-${AGENT_HEALTH_PORT}}"
  AGENT_LOG_READER_PORT="${SYMBIO_AGENT_LOG_READER_PORT:-${AGENT_LOG_READER_PORT}}"
  AGENT_BRIDGE_IP="${SYMBIO_AGENT_BRIDGE_IP:-${AGENT_BRIDGE_IP}}"
  AGENT_LOG_GROUP_GID="${SYMBIO_AGENT_LOG_GROUP_GID:-${AGENT_LOG_GROUP_GID}}"
fi

# Local-source mode is explicit and validates the complete two-container tree
# before creating credentials or changing any installation path.
if [ -n "${SOURCE_DIR}" ]; then
  case "${SOURCE_DIR}" in
    /*) ;;
    *) log "SYMBIO_SOURCE_DIR must be an absolute path."; exit 1 ;;
  esac
  if [ ! -f "${SOURCE_DIR}/compose.yaml" ] \
    || [ ! -d "${SOURCE_DIR}/mothership" ] \
    || [ ! -d "${SOURCE_DIR}/agent" ]; then
    log "SYMBIO_SOURCE_DIR does not contain a complete Symbio source tree."
    exit 1
  fi
fi

# Checks obvious TCP conflicts when ss is available; Docker remains the final authority.
if command -v ss >/dev/null 2>&1; then
  for port in "${PUBLIC_PORT}" "${INTERNAL_PORT}" "${AGENT_HEALTH_PORT}" "${AGENT_LOG_READER_PORT}"; do
    if ss -ltn | awk '{print $4}' | grep -Eq "[:.]${port}$"; then
      log "TCP port ${port} is already in use. Set a SYMBIO_*_PORT override and retry."
      exit 1
    fi
  done
fi

# The dedicated log listener binds only to Docker's bridge gateway so the
# mothership can reach the host-networked agent without exposing a public port.
if [ -z "${AGENT_BRIDGE_IP}" ]; then
  AGENT_BRIDGE_IP="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || true)"
fi
if ! printf '%s' "${AGENT_BRIDGE_IP}" | awk -F. 'NF == 4 && $1 <= 255 && $2 <= 255 && $3 <= 255 && $4 <= 255 { exit 0 } { exit 1 }'; then
  log "Could not determine a valid Docker bridge gateway for the private log reader."
  exit 1
fi

# Standard Ubuntu Nginx/Apache logs use the adm group. Docker maps this host
# numeric GID into the non-root agent as a supplementary read-only group.
if [ -z "${AGENT_LOG_GROUP_GID}" ]; then
  AGENT_LOG_GROUP_GID="$(getent group adm | awk -F: '{print $3}' || true)"
fi
if ! printf '%s' "${AGENT_LOG_GROUP_GID}" | grep -Eq '^[0-9]+$'; then
  log "Could not determine the host adm group GID for registered log access."
  exit 1
fi

log "WARNING: Symbio Beta defaults to http://${BIND_IP}:${PUBLIC_PORT} without HTTPS."
log "Passwords and sessions are not protected from network interception on public HTTP."
log "Do not call this a production-secure public deployment."

INSTALL_STARTED=1
if [ "${REUSE_DATA}" -eq 1 ]; then
  log "Reusing existing Symbio credentials and named data volumes."
else
  mkdir -p "${CONFIG_DIR}"
  # Generates a 256-bit shared secret without placing it in process arguments or logs.
  dd if=/dev/urandom bs=32 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n' >"${CONFIG_DIR}/agent-token"
fi
# The root-only parent directory protects this file on the host, while 0444
# lets the non-root container users read the file after Docker bind-mounts it.
chmod 700 "${CONFIG_DIR}"
chmod 444 "${CONFIG_DIR}/agent-token"

if [ -n "${SOURCE_DIR}" ]; then
  run_logged "Preparing the copied VM test source..." mkdir -p "${STAGING_DIR}"
  run_logged "Copying the supplied Symbio source tree..." cp -a "${SOURCE_DIR}/." "${STAGING_DIR}/"
else
  run_logged "Cloning the current Beta main branch..." git clone --depth 1 --branch main "${REPOSITORY}" "${STAGING_DIR}"
fi
if [ "${SKIP_BUILD}" -eq 1 ]; then
  for image in symbio-mothership:beta symbio-agent:beta; do
    if ! docker image inspect "${image}" >/dev/null 2>&1; then
      log "Required preloaded image is missing: ${image}"
      exit 1
    fi
  done
  log "Using preloaded mothership and agent images."
else
  run_logged "Building mothership and agent images locally..." sh -c "cd '${STAGING_DIR}' && SYMBIO_CONFIG_DIR='${CONFIG_DIR}' docker compose build"
fi

SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
mv "${STAGING_DIR}" "${INSTALL_DIR}"
if [ -n "${DEPLOY_ENV_FILE}" ]; then
  cp "${DEPLOY_ENV_FILE}" "${INSTALL_DIR}/.env"
else
  {
    printf 'SYMBIO_CONFIG_DIR=%s\n' "${CONFIG_DIR}"
    printf 'SYMBIO_BIND_IP=%s\n' "${BIND_IP}"
    printf 'SYMBIO_PORT=%s\n' "${PUBLIC_PORT}"
    printf 'SYMBIO_INTERNAL_PORT=%s\n' "${INTERNAL_PORT}"
    printf 'SYMBIO_AGENT_HEALTH_PORT=%s\n' "${AGENT_HEALTH_PORT}"
    printf 'SYMBIO_AGENT_LOG_READER_PORT=%s\n' "${AGENT_LOG_READER_PORT}"
    printf 'SYMBIO_AGENT_BRIDGE_IP=%s\n' "${AGENT_BRIDGE_IP}"
    printf 'SYMBIO_AGENT_LOG_GROUP_GID=%s\n' "${AGENT_LOG_GROUP_GID}"
    printf 'SYMBIO_SERVER_IP=%s\n' "${SERVER_IP}"
  } >"${INSTALL_DIR}/.env"
fi
chmod 600 "${INSTALL_DIR}/.env"

run_logged "Applying explicit database migrations..." sh -c "cd '${INSTALL_DIR}' && docker compose run --rm mothership npm run migrate"
if [ "${REUSE_DATA}" -eq 1 ]; then
  log "Preserved existing users; superadmin seeding was skipped."
else
  log "Create the initial superadmin. Password input is read from the terminal and is not logged."
  if ! (cd "${INSTALL_DIR}" && docker compose run --rm mothership npm run seed:superadmin </dev/tty >/dev/tty 2>/dev/tty); then
    log "Superadmin creation failed or was cancelled."
    exit 1
  fi
fi

if ! run_logged "Starting Symbio..." sh -c "cd '${INSTALL_DIR}' && docker compose up -d"; then
  log "Capturing failed container status and logs before rollback."
  (cd "${INSTALL_DIR}" && docker compose ps && docker compose logs --no-color --tail=200) >>"${LOG_FILE}" 2>&1 || true
  exit 1
fi

# Waits for Compose health rather than mistaking a merely started process for readiness.
attempt=0
while [ "${attempt}" -lt 30 ]; do
  mothership_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' symbio-mothership 2>/dev/null || true)"
  agent_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' symbio-agent 2>/dev/null || true)"
  if [ "${mothership_health}" = "healthy" ] && [ "${agent_health}" = "healthy" ]; then break; fi
  attempt=$((attempt + 1))
  sleep 2
done
if [ "${mothership_health:-}" != "healthy" ] || [ "${agent_health:-}" != "healthy" ]; then
  log "Containers did not become healthy before the installation timeout."
  exit 1
fi

trap - EXIT INT TERM
log "Symbio Beta installation completed."
log "Dashboard: http://127.0.0.1:${PUBLIC_PORT}"
if [ -n "${SERVER_IP}" ]; then log "Detected server address: http://${SERVER_IP}:${PUBLIC_PORT}"; fi
log "Installation log: ${LOG_FILE}"
log "REMINDER: direct public HTTP is unencrypted. Place Symbio behind HTTPS before production use."
