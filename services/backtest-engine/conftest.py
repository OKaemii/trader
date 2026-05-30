"""Put the service root on sys.path so tests can `import src.application.*` regardless of the
directory pytest is invoked from (CI runs it from the repo root). The pure application modules
(multiple_testing, benchmark, regime, replay_pnl, walk_forward) need only numpy/scipy — they do
not import FastAPI/motor/quant_core — so they are unit-testable without the full app wired up."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
