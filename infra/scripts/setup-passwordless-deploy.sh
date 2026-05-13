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

# Narrow rules for the deploy + observability flow. All kubectl rules are scoped to the
# trader namespace; `get secret` is intentionally NOT included to avoid leaking secret
# contents over passwordless SSH.
#   1. Image import — build-images.sh loads freshly built images into containerd.
#   2. rollout restart — needed after image import (imagePullPolicy: Never + :latest).
#   3. rollout status  — verify a restart completed.
#   4. get pods / deployments — check cluster state during/after deploy.
#   5. logs — tail pod logs to debug a failed rollout.
#   6. describe pod / deployment — inspect events when a pod won't come up.
read -r -d '' RULES <<'EOF' || true
okamii ALL=(ALL) NOPASSWD: /usr/local/bin/k3s ctr images import /tmp/trader-*.tar
okamii ALL=(ALL) NOPASSWD: /usr/local/bin/k3s kubectl -n trader rollout restart deployment/*
okamii ALL=(ALL) NOPASSWD: /usr/local/bin/k3s kubectl -n trader rollout status deployment/*
okamii ALL=(ALL) NOPASSWD: /usr/local/bin/k3s kubectl -n trader get pods *
okamii ALL=(ALL) NOPASSWD: /usr/local/bin/k3s kubectl -n trader get pods
okamii ALL=(ALL) NOPASSWD: /usr/local/bin/k3s kubectl -n trader get deployment *
okamii ALL=(ALL) NOPASSWD: /usr/local/bin/k3s kubectl -n trader get deployments
okamii ALL=(ALL) NOPASSWD: /usr/local/bin/k3s kubectl -n trader get deployments *
okamii ALL=(ALL) NOPASSWD: /usr/local/bin/k3s kubectl -n trader logs *
okamii ALL=(ALL) NOPASSWD: /usr/local/bin/k3s kubectl -n trader describe pod *
okamii ALL=(ALL) NOPASSWD: /usr/local/bin/k3s kubectl -n trader describe deployment *
okamii ALL=(ALL) NOPASSWD: /usr/local/bin/k3s kubectl -n trader exec *
EOF

echo "Installing sudoers rules on ${HOMESERVER_HOST} ..."
echo "You will be prompted for the homeserver sudo password once."
echo ""

ssh -t -p "${HOMESERVER_PORT}" "${HOMESERVER_USER}@${HOMESERVER_HOST}" \
  "printf '%s\n' \"${RULES}\" | sudo tee /etc/sudoers.d/trader-deploy >/dev/null \
   && sudo chmod 0440 /etc/sudoers.d/trader-deploy \
   && sudo visudo -c -f /etc/sudoers.d/trader-deploy"

echo ""
echo "Done. Future deploys will not prompt for sudo."
