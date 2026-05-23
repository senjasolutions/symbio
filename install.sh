#!/bin/sh
set -eu

IMAGE_NAME="${SYMBIO_IMAGE:-symbio-agent:local}"
CONTAINER_NAME="${SYMBIO_CONTAINER:-symbio-agent}"
HOST_PORT="${SYMBIO_PORT:-8765}"
DATA_VOLUME="${SYMBIO_DATA_VOLUME:-symbio-agent-data}"
REPOS_PATH="${SYMBIO_REPOS_PATH:-}"
LOGS_PATH="${SYMBIO_LOGS_PATH:-}"
CONFIGS_PATH="${SYMBIO_CONFIGS_PATH:-}"
ENABLE_DOCKER_SOCKET="${SYMBIO_ENABLE_DOCKER_SOCKET:-0}"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ONBOARDING_URL="http://127.0.0.1:${HOST_PORT}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required before installing Symbio."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker CLI is installed, but the Docker daemon is not reachable."
  echo "Start Docker on this machine, then rerun this installer."
  exit 1
fi

SERVER_IP=""
if command -v hostname >/dev/null 2>&1; then
  SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
fi

echo "Building ${IMAGE_NAME}..."
docker build -t "${IMAGE_NAME}" "${SCRIPT_DIR}"

echo "Preparing data volume ${DATA_VOLUME}..."
docker volume create "${DATA_VOLUME}" >/dev/null

if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
  echo "Replacing existing ${CONTAINER_NAME} container..."
  docker rm -f "${CONTAINER_NAME}" >/dev/null
fi

echo "Starting ${CONTAINER_NAME}..."
set -- \
  --name "${CONTAINER_NAME}" \
  --restart unless-stopped \
  -p "0.0.0.0:${HOST_PORT}:8080" \
  -v "${DATA_VOLUME}:/data"

if [ -n "${REPOS_PATH}" ]; then
  if [ ! -d "${REPOS_PATH}" ]; then
    echo "SYMBIO_REPOS_PATH does not exist or is not a directory: ${REPOS_PATH}"
    exit 1
  fi
  set -- "$@" -v "${REPOS_PATH}:/host/repos"
fi

if [ -n "${LOGS_PATH}" ]; then
  if [ ! -d "${LOGS_PATH}" ]; then
    echo "SYMBIO_LOGS_PATH does not exist or is not a directory: ${LOGS_PATH}"
    exit 1
  fi
  set -- "$@" -v "${LOGS_PATH}:/host/logs:ro"
fi

if [ -n "${CONFIGS_PATH}" ]; then
  if [ ! -d "${CONFIGS_PATH}" ]; then
    echo "SYMBIO_CONFIGS_PATH does not exist or is not a directory: ${CONFIGS_PATH}"
    exit 1
  fi
  set -- "$@" -v "${CONFIGS_PATH}:/host/configs:ro"
fi

if [ "${ENABLE_DOCKER_SOCKET}" = "1" ]; then
  if [ ! -S "/var/run/docker.sock" ]; then
    echo "SYMBIO_ENABLE_DOCKER_SOCKET=1 was set, but /var/run/docker.sock is not available."
    exit 1
  fi
  set -- "$@" -v "/var/run/docker.sock:/var/run/docker.sock"
fi

set -- "$@" "${IMAGE_NAME}"
docker run -d "$@" >/dev/null

echo ""
echo "Symbio onboarding is ready:"
echo "${ONBOARDING_URL}"
if [ -n "${SERVER_IP}" ]; then
  echo "http://${SERVER_IP}:${HOST_PORT}"
fi
echo ""
echo "If this is a remote webserver, open the URL through SSH port forwarding or expose ${HOST_PORT} only to trusted networks."
echo "Optional host access mounts:"
echo "  SYMBIO_REPOS_PATH=/path/to/repos      mounts read/write at /host/repos"
echo "  SYMBIO_LOGS_PATH=/path/to/logs        mounts read-only at /host/logs"
echo "  SYMBIO_CONFIGS_PATH=/path/to/configs  mounts read-only at /host/configs"
echo "  SYMBIO_ENABLE_DOCKER_SOCKET=1         mounts Docker socket with host-level risk"

if command -v open >/dev/null 2>&1; then
  open "${ONBOARDING_URL}" >/dev/null 2>&1 || true
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "${ONBOARDING_URL}" >/dev/null 2>&1 || true
fi
