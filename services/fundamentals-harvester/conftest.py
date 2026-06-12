"""Put the service root on sys.path so tests can `import src.main` / `import src.normalize`
regardless of the directory pytest is invoked from (CI runs the python gate from the repo root,
mirroring how backtest-engine's, fundamentals-ingestion's, and fundamentals-api's conftests work).

The harvester modules use bare imports between themselves (`from edgar import Edgar`,
`from normalize import write_company_facts`) — the deployed image runs from `src/` so they resolve as
top-level modules. The tests `import src.main` / `import src.normalize`, so `src/` must ALSO be on the
path for those bare intra-package imports to resolve; both `<service-root>` and `<service-root>/src`
are inserted below. The only third-party deps the tests touch are pyarrow (the [lake] extra) and the
installed `quant_core` — no network, no EDGAR client construction (which would fail-closed without a
real EDGAR_USER_AGENT)."""
import os
import sys

_ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _ROOT)
sys.path.insert(0, os.path.join(_ROOT, "src"))
