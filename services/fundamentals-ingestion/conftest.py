"""Put the service root on sys.path so tests can `import src.main` / `import src.<stage>` regardless
of the directory pytest is invoked from (CI runs the python gate from the repo root, mirroring how
backtest-engine's conftest works). The skeleton's app + stage packages import only FastAPI/pydantic
and the installed `quant_core` — no live Mongo/Timescale connection — so they unit-test without any
infrastructure wired up."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
