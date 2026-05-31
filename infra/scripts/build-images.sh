#!/usr/bin/env bash
# BREAK-GLASS local image build. The normal build+deploy path is GitHub Actions
# (.github/workflows/build-deploy.yml → GHCR → helm upgrade). Use this only when CI
# is unavailable and you need to side-load an image straight into the homeserver's
# k3s containerd.
#
# Images are tagged ghcr.io/okaemii/trader-<service>:latest to match the chart's
# composed default ref. With imagePullPolicy=IfNotPresent, a locally-imported :latest
# is used without hitting the registry. To roll the cluster onto these local images:
#   helm upgrade --install trader-app infra/helm/trader -n trader   # renders :latest
#
# Usage:
#   ./infra/scripts/build-images.sh              # build + load all images
#   ./infra/scripts/build-images.sh signal-service  # build + load one service only
#
# Requirements: docker, ssh, scp — SSH key recommended (avoids repeated password prompts).
#
# Run from the repo root.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOMESERVER_USER="okamii"
HOMESERVER_HOST="192.168.50.2"
HOMESERVER_PORT="1984"
HOMESERVER="${HOMESERVER_USER}@${HOMESERVER_HOST}"

if [[ -z "${HOMESERVER_SSH_KEY:-}" ]]; then
  echo "Error: HOMESERVER_SSH_KEY env var is not set. Run infra/scripts/setup-agent-ssh.sh first." >&2
  exit 1
fi
TMPKEY="$(mktemp)"
printf '%b' "${HOMESERVER_SSH_KEY}" > "${TMPKEY}"
chmod 600 "${TMPKEY}"
trap 'rm -f "${TMPKEY}"' EXIT

TS_SERVICES=(
  auth-service
  market-data-service
  signal-service
  notification-service
  trading-service
  portfolio-service
)

build_and_load() {
  local service="$1"
  local tag="ghcr.io/okaemii/trader-${service}:latest"
  local tmpfile="/tmp/trader-${service}.tar"

  echo ""
  echo "══════════════════════════════════════════"
  echo "  Building: ${tag}"
  echo "══════════════════════════════════════════"

  case "${service}" in
    strategy-engine)
      docker build \
        -f infra/docker/strategy-engine.Dockerfile \
        -t "${tag}" \
        "${REPO_ROOT}"
      ;;
    backtest-engine)
      docker build \
        -f infra/docker/backtest-engine.Dockerfile \
        -t "${tag}" \
        "${REPO_ROOT}"
      ;;
    frontend-web)
      docker build \
        -f infra/docker/frontend-web.Dockerfile \
        -t "${tag}" \
        "${REPO_ROOT}"
      ;;
    warehouse-snapshotter)
      docker build \
        -f infra/docker/warehouse-snapshotter.Dockerfile \
        -t "${tag}" \
        "${REPO_ROOT}"
      ;;
    *)
      docker build \
        -f infra/docker/node-service.Dockerfile \
        --build-arg SERVICE="${service}" \
        -t "${tag}" \
        "${REPO_ROOT}"
      ;;
  esac

  echo "--> Saving ${tag} to ${tmpfile} ..."
  docker save "${tag}" -o "${tmpfile}"

  echo "--> Uploading to homeserver ..."
  scp -i "${TMPKEY}" -P "${HOMESERVER_PORT}" "${tmpfile}" "${HOMESERVER}:/tmp/"

  echo "--> Importing into k3s containerd ..."
  ssh -i "${TMPKEY}" -p "${HOMESERVER_PORT}" "${HOMESERVER}" \
    "sudo k3s ctr images import /tmp/trader-${service}.tar && rm /tmp/trader-${service}.tar"

  rm -f "${tmpfile}"
  echo "--> Done: ${tag}"
  echo "BUILD_OK ${tag}"
}

# Wrap calls so a pipefail-less caller (e.g. `./build-images.sh foo 2>&1 | tail`) still
# sees an unmissable failure marker. The script body has `set -e` and aborts on the first
# failing command, but stdout's last lines may not surface "ALL BUILDS COMPLETE" — the
# `BUILD_OK <tag>` line per successful image is the source of truth.


verify_images() {
  echo ""
  echo "Verifying imported images on homeserver ..."
  ssh -i "${TMPKEY}" -p "${HOMESERVER_PORT}" "${HOMESERVER}" \
    "sudo k3s ctr images list | grep 'okaemii/trader-'"
}

cd "${REPO_ROOT}"

TARGET="${1:-all}"

if [[ "${TARGET}" == "all" ]]; then
  for svc in "${TS_SERVICES[@]}"; do
    build_and_load "${svc}"
  done
  build_and_load "strategy-engine"
  build_and_load "backtest-engine"
  build_and_load "frontend-web"
  build_and_load "warehouse-snapshotter"
  verify_images
else
  build_and_load "${TARGET}"
fi

echo ""
echo "All images loaded into k3s containerd as ghcr.io/okaemii/trader-<svc>:latest."
echo "Roll the cluster onto them (break-glass, renders the :latest tag):"
echo "  helm upgrade --install trader-app infra/helm/trader -n trader"
