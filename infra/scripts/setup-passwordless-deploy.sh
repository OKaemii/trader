#!/usr/bin/env bash
# Install a sudoers rule on the homeserver allowing okamii to run
# `k3s ctr images import /tmp/trader-*.tar` without a password prompt.
#
# This is what unblocks non-interactive deploys via build-images.sh.
# Only narrow paths are whitelisted — okamii does NOT gain general passwordless sudo.
#
# Run ONCE, from your laptop. You will be prompted for the homeserver sudo password.

set -euo pipefail

HOMESERVER_USER="okamii"
HOMESERVER_HOST="192.168.50.2"
HOMESERVER_PORT="1984"

RULE='okamii ALL=(ALL) NOPASSWD: /usr/local/bin/k3s ctr images import /tmp/trader-*.tar'

echo "Installing sudoers rule on ${HOMESERVER_HOST} ..."
echo "You will be prompted for the homeserver sudo password once."
echo ""

ssh -t -p "${HOMESERVER_PORT}" "${HOMESERVER_USER}@${HOMESERVER_HOST}" \
  "echo '${RULE}' | sudo tee /etc/sudoers.d/trader-deploy >/dev/null \
   && sudo chmod 0440 /etc/sudoers.d/trader-deploy \
   && sudo visudo -c -f /etc/sudoers.d/trader-deploy"

echo ""
echo "Done. Future deploys will not prompt for sudo."
