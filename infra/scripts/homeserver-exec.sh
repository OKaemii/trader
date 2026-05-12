#!/usr/bin/env bash
# Run a command on the homeserver via SSH using the HOMESERVER_SSH_KEY env var.
#
# Usage:
#   ./infra/scripts/homeserver-exec.sh <command>
#   ./infra/scripts/homeserver-exec.sh kubectl get pods -A
#   ./infra/scripts/homeserver-exec.sh sudo k3s ctr images list

set -euo pipefail

HOMESERVER_USER="okamii"
HOMESERVER_HOST="192.168.50.2"
HOMESERVER_PORT="1984"

if [[ $# -eq 0 ]]; then
  echo "Usage: $(basename "$0") <command>" >&2
  exit 1
fi

if [[ -z "${HOMESERVER_SSH_KEY:-}" ]]; then
  echo "Error: HOMESERVER_SSH_KEY env var is not set. Run infra/scripts/setup-agent-ssh.sh first." >&2
  exit 1
fi

TMPKEY="$(mktemp)"
printf '%b' "${HOMESERVER_SSH_KEY}" > "${TMPKEY}"
chmod 600 "${TMPKEY}"
trap 'rm -f "${TMPKEY}"' EXIT

exec ssh -i "${TMPKEY}" -p "${HOMESERVER_PORT}" \
  -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
  "${HOMESERVER_USER}@${HOMESERVER_HOST}" "$@"
