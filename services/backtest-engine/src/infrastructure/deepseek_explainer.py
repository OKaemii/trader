"""DeepSeek explainer — turns a validation/backtest summary row into a plain-English interpretation.

Reuses the same OpenAI-compatible DeepSeek API the notification-service uses (DEEPSEEK_API_KEY in
trader-secrets). Stdlib-only (urllib) so backtest-engine gains no new dependency; the blocking call
is meant to run via `asyncio.to_thread`. The explanation is cached on the `backtest_results` row
(`ai_explanation`) so the portal never re-queries the LLM for the same report.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Optional

DEEPSEEK_BASE = "https://api.deepseek.com"
MODEL = "deepseek-chat"

# Fields worth handing the model. Anything missing is simply omitted from the prompt.
_PROMPT_KEYS = [
    "strategy_id", "engine", "passed", "failures", "oos_sharpe", "mean_ic", "dsr", "pbo",
    "fdr_p", "n_trials", "universe_size", "mcpt_in_sample_quasi_p", "mcpt_walk_forward_quasi_p",
    "benchmark", "data_source", "data_quality",
]

_SYSTEM = (
    "You are a quantitative analyst explaining a trading-strategy validation report to a portfolio "
    "manager who is not a statistician. Explain, in plain English, what the numbers mean and whether "
    "the strategy looks genuinely robust or possibly overfit. Be specific and honest about weaknesses. "
    "Do NOT invent any number that is not in the data. Cover, in flowing prose (no markdown headers): "
    "the overall verdict (pass/fail and the main reason); out-of-sample Sharpe; the MCPT permutation "
    "p-values (explain they test whether the edge could be luck — lower is better, <0.05 is good); "
    "PBO (probability of backtest overfitting — higher is worse, >0.5 is a red flag); the deflated "
    "Sharpe ratio; information coefficient (IC); the FDR-corrected p-value; and the benchmark "
    "comparison. Finish with one sentence of practical guidance. Keep it to ~180 words."
)


def is_available() -> bool:
    return bool(os.getenv("DEEPSEEK_API_KEY", ""))


def _build_user_prompt(summary: dict) -> str:
    payload = {k: summary.get(k) for k in _PROMPT_KEYS if summary.get(k) is not None}
    return "Here is the validation report (JSON):\n" + json.dumps(payload, default=str, indent=2)


def explain_report(summary: dict, timeout: float = 60.0) -> Optional[dict]:
    """Blocking DeepSeek call — run via asyncio.to_thread. Returns {text, model, generated_at} or
    None when the key is unset or the call fails (never raises into the caller)."""
    key = os.getenv("DEEPSEEK_API_KEY", "")
    if not key:
        return None
    body = json.dumps({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": _build_user_prompt(summary)},
        ],
        "max_tokens": 600,
        "temperature": 0.3,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{DEEPSEEK_BASE}/chat/completions",
        data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:   # noqa: S310 — fixed DeepSeek host
            data = json.loads(resp.read().decode("utf-8"))
        text = ((data.get("choices") or [{}])[0].get("message") or {}).get("content", "").strip()
        if not text:
            return None
        return {"text": text, "model": MODEL, "generated_at": datetime.now(timezone.utc)}
    except (urllib.error.URLError, TimeoutError, ValueError, KeyError, OSError) as exc:
        print(f"[deepseek-explainer] explain failed: {exc!r}", flush=True)
        return None
