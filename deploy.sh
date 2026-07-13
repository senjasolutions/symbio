#!/bin/sh
# Builds Symbio locally, copies the exact working tree and images to a disposable
# Ubuntu VM, and exercises installation without depending on GitHub main.
set -eu

REMOTE="${SYMBIO_TEST_REMOTE:-root@192.168.123.242}"
SSH_KEY="${SYMBIO_TEST_SSH_KEY:-${HOME}/.ssh/id_rsa}"
RESET_MODE="none"
REMOTE_STAGE="/tmp/symbio-install-test"
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SSH_AGENT_STARTED=0
REMOTE_STAGE_CREATED=0

# Stops an agent started by this script and removes the remote source staging
# directory; installed Symbio state remains available for inspection.
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ "$REMOTE_STAGE_CREATED" -eq 1 ]; then
    ssh "$REMOTE" "rm -rf '$REMOTE_STAGE'" >/dev/null 2>&1 || true
  fi
  if [ "$SSH_AGENT_STARTED" -eq 1 ]; then
    ssh-agent -k >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

# Prints one stable section heading so a failed test step is easy to locate.
section() {
  printf '\n=== %s ===\n' "$1"
}

# Documents the data-preserving and destructive replacement modes separately.
usage() {
  printf 'Usage: %s [--reset | --reset-data]\n' "$0"
  printf '  --reset       Replace application files and containers; preserve configuration and databases.\n'
  printf '  --reset-data  Delete the complete Symbio installation, including configuration and databases.\n'
}

# Reset modes are mutually exclusive so an accidental extra flag can never
# broaden a data-preserving deployment into database deletion.
while [ "$#" -gt 0 ]; do
  case "$1" in
    --reset|--reset-data)
      if [ "$RESET_MODE" != "none" ]; then
        echo "Choose only one reset mode." >&2
        usage >&2
        exit 2
      fi
      if [ "$1" = "--reset" ]; then RESET_MODE="application"; else RESET_MODE="data"; fi
      ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [ ! -r "$SSH_KEY" ]; then
  printf 'SSH private key is not readable: %s\n' "$SSH_KEY" >&2
  exit 1
fi
for command in docker gzip ssh ssh-add ssh-agent tar; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Missing local prerequisite: %s\n' "$command" >&2
    exit 1
  fi
done
if ! docker info >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  printf 'A running local Docker Engine with Compose v2 is required.\n' >&2
  exit 1
fi

# Reuses the caller's SSH agent when present; otherwise one temporary agent
# prevents repeated key-passphrase prompts during a multi-step deployment.
if [ -z "${SSH_AUTH_SOCK:-}" ]; then
  eval "$(ssh-agent -s)" >/dev/null
  SSH_AGENT_STARTED=1
fi
ssh-add "$SSH_KEY"

section "Checking test VM"
ssh "$REMOTE" sh -s -- "$RESET_MODE" <<'REMOTE_PREFLIGHT'
set -eu
reset_mode=$1

if [ "$(id -u)" -ne 0 ]; then
  echo "The remote account must be root." >&2
  exit 1
fi

rm -rf /tmp/symbio-install-test
mkdir -p /tmp/symbio-install-test/source

existing=0
if [ -e /opt/symbio ] || [ -e /etc/symbio ]; then existing=1; fi
if command -v docker >/dev/null 2>&1; then
  if docker container inspect symbio-agent >/dev/null 2>&1 \
    || docker container inspect symbio-mothership >/dev/null 2>&1 \
    || docker volume inspect symbio-agent-data >/dev/null 2>&1 \
    || docker volume inspect symbio-mothership-data >/dev/null 2>&1; then
    existing=1
  fi
fi

# Removes only fixed Phase 1 containers; application-only reset deliberately
# leaves both named data volumes untouched.
remove_known_containers() {
  for container in symbio-agent symbio-mothership; do
    if docker container inspect "$container" >/dev/null 2>&1; then
      docker rm -f "$container"
    fi
  done
}

# Full reset removes only Symbio's fixed named volumes, never unrelated data.
remove_known_volumes() {
  for volume in symbio-agent-data symbio-mothership-data; do
    if docker volume inspect "$volume" >/dev/null 2>&1; then
      docker volume rm "$volume"
    fi
  done
}

case "$reset_mode" in
  none)
    if [ "$existing" -eq 1 ]; then
      echo "An existing Symbio installation was found." >&2
      echo "Use --reset to preserve data, or --reset-data to delete everything." >&2
      exit 1
    fi
    ;;
  application)
    if [ "$existing" -eq 0 ]; then
      echo "Application-only reset requires an existing Symbio installation. Run without a flag for a fresh install." >&2
      exit 1
    fi
    if [ ! -s /etc/symbio/agent-token ] \
      || ! docker volume inspect symbio-mothership-data >/dev/null 2>&1 \
      || ! docker volume inspect symbio-agent-data >/dev/null 2>&1; then
      echo "Cannot preserve data: existing credentials or named data volumes are incomplete." >&2
      echo "Repair the VM state or use --reset-data for an explicitly destructive reset." >&2
      exit 1
    fi
    echo "Application reset requested: preserving configuration, credentials, and databases."
    if [ -f /opt/symbio/.env ]; then
      cp /opt/symbio/.env /tmp/symbio-install-test/preserved.env
      chmod 600 /tmp/symbio-install-test/preserved.env
    fi
    if [ -f /opt/symbio/compose.yaml ]; then
      if ! (cd /opt/symbio && docker compose down --remove-orphans); then
        echo "Compose cleanup failed; removing only known Symbio containers."
        remove_known_containers
      fi
    else
      remove_known_containers
    fi
    rm -rf /opt/symbio
    ;;
  data)
    echo "Full data reset requested: removing application files, configuration, credentials, and databases."
    if [ -f /opt/symbio/compose.yaml ]; then
      if ! (cd /opt/symbio && docker compose down -v --remove-orphans); then
        echo "Compose cleanup failed; removing only known Symbio containers and volumes."
        remove_known_containers
        remove_known_volumes
      fi
    else
      remove_known_containers
      remove_known_volumes
    fi
    rm -rf /opt/symbio /etc/symbio /var/log/symbio
    ;;
  *)
    echo "Unsupported reset mode: $reset_mode" >&2
    exit 1
    ;;
esac
REMOTE_PREFLIGHT
REMOTE_STAGE_CREATED=1

section "Building images locally"
# Local BuildKit caching makes repeat deployments fast and avoids compiling two
# native SQLite modules on the smaller VM.
docker compose build

section "Transferring locally built images"
# Docker backends expose different image IDs for identical content, so compare
# stable runtime configuration and filesystem layers instead. Changed images
# still share base layers in one compressed archive.
IMAGE_FINGERPRINT_FORMAT='{{.Architecture}}|{{.Os}}|{{.Config.User}}|{{json .Config.Env}}|{{json .Config.Entrypoint}}|{{json .Config.Cmd}}|{{.Config.WorkingDir}}|{{json .Config.Healthcheck}}|{{json .RootFS.Layers}}'
IMAGES_TO_TRANSFER=""
for image in symbio-mothership:beta symbio-agent:beta; do
  local_fingerprint=$(docker image inspect --format "$IMAGE_FINGERPRINT_FORMAT" "$image")
  remote_fingerprint=$(ssh "$REMOTE" "docker image inspect --format '$IMAGE_FINGERPRINT_FORMAT' '$image' 2>/dev/null || true")
  if [ "$local_fingerprint" != "$remote_fingerprint" ]; then
    IMAGES_TO_TRANSFER="${IMAGES_TO_TRANSFER} ${image}"
  fi
done
if [ -n "$IMAGES_TO_TRANSFER" ]; then
  # Word splitting is intentional because the list contains only fixed image
  # names declared directly above, never operator input.
  docker save $IMAGES_TO_TRANSFER \
    | gzip -1 \
    | ssh "$REMOTE" "gzip -d | docker load"
else
  echo "VM images already match the local build; transfer skipped."
fi
ssh "$REMOTE" sh -s <<'REMOTE_IMAGES'
set -eu
normalize_arch() {
  case "$1" in
    amd64|x86_64) echo amd64 ;;
    arm64|aarch64) echo arm64 ;;
    *) echo "$1" ;;
  esac
}
host_arch=$(normalize_arch "$(docker version --format '{{.Server.Arch}}')")
for image in symbio-mothership:beta symbio-agent:beta; do
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    echo "Transferred image is missing: $image" >&2
    exit 1
  fi
  image_arch=$(normalize_arch "$(docker image inspect --format '{{.Architecture}}' "$image")")
  if [ "$image_arch" != "$host_arch" ]; then
    echo "Image $image uses $image_arch but the VM uses $host_arch." >&2
    exit 1
  fi
done
REMOTE_IMAGES

section "Transferring current working tree"
# Exclusions prevent local dependencies, Git metadata, runtime databases, and
# credentials from being copied into the disposable source repository.
tar -C "$DIR" \
  --exclude='./.git' \
  --exclude='./.symbio' \
  --exclude='./.env' \
  --exclude='./node_modules' \
  --exclude='./mothership/node_modules' \
  --exclude='./agent/node_modules' \
  --exclude='*.sqlite' \
  --exclude='*.sqlite-shm' \
  --exclude='*.sqlite-wal' \
  -czf - . | ssh "$REMOTE" "tar -xzf - -C '$REMOTE_STAGE/source'"

section "Validating copied installer source"
# The VM uses the copied tree directly; Git metadata and a temporary commit are
# neither transferred nor created for local installation testing.
ssh "$REMOTE" sh -s <<'REMOTE_SOURCE'
set -eu
cd /tmp/symbio-install-test/source
test -f compose.yaml
test -d mothership
test -d agent
test -x install.sh || chmod +x install.sh
REMOTE_SOURCE

section "Running VM installer"
# A forced pseudo-terminal is required because the superadmin seeder reads its
# password directly from /dev/tty to keep it out of logs and shell history.
if [ "$RESET_MODE" = "application" ]; then
  if ssh "$REMOTE" "test -f '$REMOTE_STAGE/preserved.env'"; then
    ssh -tt "$REMOTE" "SYMBIO_SOURCE_DIR='$REMOTE_STAGE/source' SYMBIO_SKIP_BUILD=1 SYMBIO_REUSE_DATA=1 SYMBIO_DEPLOY_ENV_FILE='$REMOTE_STAGE/preserved.env' '$REMOTE_STAGE/source/install.sh'"
  else
    ssh -tt "$REMOTE" "SYMBIO_SOURCE_DIR='$REMOTE_STAGE/source' SYMBIO_SKIP_BUILD=1 SYMBIO_REUSE_DATA=1 '$REMOTE_STAGE/source/install.sh'"
  fi
else
  ssh -tt "$REMOTE" "SYMBIO_SOURCE_DIR='$REMOTE_STAGE/source' SYMBIO_SKIP_BUILD=1 '$REMOTE_STAGE/source/install.sh'"
fi

section "Verifying installed service"
ssh "$REMOTE" sh -s <<'REMOTE_VERIFY'
set -eu
cd /opt/symbio

mothership_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' symbio-mothership)
agent_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' symbio-agent)
if [ "$mothership_health" != "healthy" ] || [ "$agent_health" != "healthy" ]; then
  docker compose ps
  docker compose logs --no-color --tail=150
  echo "Symbio containers are not healthy." >&2
  exit 1
fi

# The diagnostic payload proves that collection ran, a report reached the
# mothership, and no queued report or worker error remains after installation.
docker exec symbio-agent node -e '
  fetch("http://127.0.0.1:" + (process.env.SYMBIO_AGENT_HEALTH_PORT || 18767) + "/api/v1/status")
    .then((response) => response.json())
    .then((status) => {
      if (!status.lastCollectionAt || !status.lastDeliveryAt || status.outboxCount !== 0 || status.lastError) {
        console.error(JSON.stringify(status));
        process.exit(1);
      }
      console.log(JSON.stringify(status));
    })
    .catch((error) => { console.error(error.message); process.exit(1); });
'

docker compose ps
REMOTE_VERIFY

REMOTE_HOST=${REMOTE#*@}
section "VM installation test passed"
printf 'Dashboard: http://%s:8765\n' "$REMOTE_HOST"
printf 'SSH tunnel: ssh -L 8765:127.0.0.1:8765 %s\n' "$REMOTE"
printf 'Installer log: ssh %s tail -n 200 /var/log/symbio/install.log\n' "$REMOTE"
printf 'Application-only redeploy: ./deploy.sh --reset\n'
printf 'Destructive data reset: ./deploy.sh --reset-data\n'
