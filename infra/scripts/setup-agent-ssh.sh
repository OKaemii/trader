#!/usr/bin/env bash
# Generate a dedicated SSH keypair for homeserver access, install the public key
# on the server, and export the private key as HOMESERVER_SSH_KEY in your shell
# profile(s).
#
# Usage:
#   ./infra/scripts/setup-agent-ssh.sh
#
# After running, reload your shell and use:
#   ./infra/scripts/homeserver-exec.sh <command>

set -euo pipefail

HOMESERVER_USER="okamii"
HOMESERVER_HOST="192.168.50.2"
HOMESERVER_PORT="1984"
KEY_PATH="$(mktemp -d)/trader_agent_ed25519"

echo "Generating keypair ..."
ssh-keygen -t ed25519 -f "${KEY_PATH}" -N "" -C "trader-agent@$(hostname)"

echo ""
echo "Installing public key on homeserver (you may be prompted for your password) ..."
ssh-copy-id -i "${KEY_PATH}.pub" -p "${HOMESERVER_PORT}" "${HOMESERVER_USER}@${HOMESERVER_HOST}"

echo ""
echo "Verifying connection ..."
ssh -i "${KEY_PATH}" -p "${HOMESERVER_PORT}" -o BatchMode=yes \
  "${HOMESERVER_USER}@${HOMESERVER_HOST}" "echo 'SSH auth: OK'"

# Encode newlines so the key fits on a single export line.
PRIVATE_KEY_ESCAPED="$(awk '{printf "%s\\n", $0}' "${KEY_PATH}")"
EXPORT_LINE="export HOMESERVER_SSH_KEY=\"${PRIVATE_KEY_ESCAPED}\""

add_to_profile() {
  local profile="$1"
  if [[ -f "${profile}" ]]; then
    if grep -q "HOMESERVER_SSH_KEY" "${profile}"; then
      echo "HOMESERVER_SSH_KEY already present in ${profile} — skipping"
    else
      printf '\n# trader homeserver SSH key\n%s\n' "${EXPORT_LINE}" >> "${profile}"
      echo "Added HOMESERVER_SSH_KEY to ${profile}"
    fi
  fi
}

echo ""
echo "Saving to shell profile(s) ..."
add_to_profile "${HOME}/.bashrc"
add_to_profile "${HOME}/.zshrc"

# Clean up temp key files — the value lives in the shell profile now.
rm -f "${KEY_PATH}" "${KEY_PATH}.pub"

echo ""
echo "Done. Reload your shell or run:"
echo "  source ~/.bashrc"
echo ""
echo "Then test with:"
echo "  ./infra/scripts/homeserver-exec.sh echo hello"
