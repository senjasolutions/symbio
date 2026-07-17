#!/bin/sh
# Completely removes Symbio from a remote host — containers, volumes, config, logs.
# Useful for testing the install script without reinstalling the OS.
set -eu

REMOTE="${SYMBIO_TEST_REMOTE:-root@192.168.123.242}"
SSH_KEY="${SYMBIO_TEST_SSH_KEY:-${HOME}/.ssh/id_rsa}"
SSH_AGENT_STARTED=0

CLEAN=0

usage() {
  printf 'Usage: %s [--clean]\n' "$0"
  printf '  Removes Symbio from the remote host.\n'
  printf '  Without --clean: keeps data volumes for reinstall.\n'
  printf '  With --clean:    also deletes data volumes (full wipe).\n'
  printf '  Environment: SYMBIO_TEST_REMOTE (default %s)\n' "${SYMBIO_TEST_REMOTE:-root@192.168.123.242}"
  printf '               SYMBIO_TEST_SSH_KEY (default ~/.ssh/id_rsa)\n'
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  --clean) CLEAN=1 ;;
  -*) printf 'Unknown flag: %s\n' "$1" >&2; usage; exit 1 ;;
esac

for command in ssh ssh-agent ssh-add; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Missing prerequisite: %s\n' "$command" >&2
    exit 1
  fi
done

if [ ! -r "$SSH_KEY" ]; then
  printf 'SSH private key not readable: %s\n' "$SSH_KEY" >&2
  exit 1
fi

cleanup() {
  if [ "$SSH_AGENT_STARTED" -eq 1 ]; then
    ssh-agent -k >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

if [ -z "${SSH_AUTH_SOCK:-}" ]; then
  eval "$(ssh-agent -s)" >/dev/null
  SSH_AGENT_STARTED=1
fi
ssh-add "$SSH_KEY"

printf '\n  Connecting to %s...\n' "$REMOTE"
ssh -tt "$REMOTE" "env CLEAN=$CLEAN sh -s" <<'REMOTE_UNINSTALL'
set -eu

printf '\n  \033[1mSymbio Uninstall\033[0m\n\n'

# Kill any Symbio containers by image name (regardless of compose project)
printf '  Removing Symbio containers...\n'
docker ps -a --filter ancestor=symbio-mothership:beta -q | xargs -r docker rm -f 2>/dev/null || true
docker ps -a --filter ancestor=symbio-agent:beta -q | xargs -r docker rm -f 2>/dev/null || true
# Also catch any leftover containers by name pattern
for name in symbio-mothership symbio-agent; do
  docker rm -f "$name" 2>/dev/null || true
done
# Remove any compose project networks
docker network ls --format '{{.Name}}' | grep -E '^symbio' | xargs -r docker network rm 2>/dev/null || true
printf '  \033[1;32m✓\033[0m Containers removed\n'

# Remove Symbio Docker volumes (only with --clean, preserves data for reinstall)
if [ "${CLEAN:-0}" -eq 1 ]; then
  printf '  Removing Symbio volumes...\n'
  docker volume ls --format '{{.Name}}' | grep -E '^symbio' | xargs -r docker volume rm -f 2>/dev/null || true
  printf '  \033[1;32m✓\033[0m Volumes removed\n'
else
  printf '  \033[1;33m⏭\033[0m Volumes kept (use --clean to wipe data)\n'
fi

# Remove application directory
if [ -d /opt/symbio ]; then
  rm -rf /opt/symbio
  printf '  \033[1;32m✓\033[0m /opt/symbio removed\n'
fi

# Remove configuration directory
if [ -d /etc/symbio ]; then
  rm -rf /etc/symbio
  printf '  \033[1;32m✓\033[0m /etc/symbio removed\n'
fi

# Remove log directory
if [ -d /var/log/symbio ]; then
  rm -rf /var/log/symbio
  printf '  \033[1;32m✓\033[0m /var/log/symbio removed\n'
fi

# Remove any temp install directories
printf '  Cleaning temp directories...\n'
rm -rf /tmp/symbio-install-*
printf '  \033[1;32m✓\033[0m Temp directories removed\n'

# Remove Symbio Docker images
for img in symbio-mothership:beta symbio-agent:beta; do
  docker rmi "$img" 2>/dev/null || true
done
printf '  \033[1;32m✓\033[0m Symbio Docker images removed\n'

printf '\n  \033[1;32mSymbio has been removed from this host.\033[0m\n'
printf '  Run install.sh again to reinstall.\n'
printf '\n'
REMOTE_UNINSTALL
