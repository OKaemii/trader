#!/usr/bin/env bash
# Run the Python test suites (quant-core + backtest-engine) the one way the authoring/CI sandbox
# can't (it has no numpy): inside a deps-complete container.
#
# `docker build` of infra/docker/backtest-engine-test.Dockerfile executes BOTH pytest suites
# *during the build* — a failing assertion fails the build, so this is the real Python gate.
# Re-runs are fast: only the COPY-sources + RUN-pytest layers re-execute; the heavy
# giotto-tda/scipy/sklearn layer is cached. The image is never deployed (build-images.sh skips it).
#
# Usage: ./infra/scripts/run-python-tests.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"
docker build -f infra/docker/backtest-engine-test.Dockerfile -t trader/backtest-engine-test .
echo ""
echo "✓ Python suites passed (quant-core + backtest-engine). The build runs pytest internally;"
echo "  a non-zero exit above would mean a test failed."
