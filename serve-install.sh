#!/bin/sh
# Starts a minimal HTTP server that hosts install.sh for one-line remote installs.
# Usage:  ./serve-install.sh
#         PORT=9999 ./serve-install.sh
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PORT="${PORT:-9999}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install it first."
  exit 1
fi

exec node "${DIR}/serve-install.js"
