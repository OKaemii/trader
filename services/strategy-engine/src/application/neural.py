"""
TopologyStrategyNet — Phase 2 neural strategy (only after ablation confirms neural OOS edge).

Architecture: LSTM over sequences of Betti curve snapshots + Laplacian residuals.
Training: walk-forward with 21-day embargo; isotonic calibration on OOS confidence;
          shadow test lifecycle tracked in ModelVersionStore.

Do not enable in production until:
  1. Step 18 ablation shows neural adds statistically significant OOS IC over topology_v1 alone.
  2. 30-day shadow test passes (is_shadow_complete returns True).
  3. ModelVersionStore.promote_to_live is called by an admin.
"""
from __future__ import annotations

import os
import uuid
import pickle
import logging
from datetime import datetime, timezone, timedelta
from dataclasses import dataclass
from typing import Optional

import numpy as np
from sklearn.isotonic import IsotonicRegression
from scipy.stats import spearmanr

log = logging.getLogger(__name__)

try:
    import torch
    import torch.nn as nn
    import torch.optim as optim
    _TORCH_AVAILABLE = True
except ImportError:
    _TORCH_AVAILABLE = False
    log.warning("PyTorch not installed — TopologyStrategyNet unavailable. Add torch to requirements.txt.")


EMBARGO_DAYS    = 21   # minimum gap between train end and test start (matches walk-forward spec)
SHADOW_DAYS     = 30   # minimum shadow-test period before promotion
MIN_SAMPLES     = 500  # refuse to train on fewer sequences
ROLLING_WINDOW  = 365  # days of data used for each training fold
N_FOLDS         = 5


# ── Model definition ─────────────────────────────────────────────────────────

class TopologyStrategyNet(nn.Module):
    """
    LSTM that takes a sequence of Betti curve snapshots + Laplacian residuals
    and predicts refined portfolio weights.

    Input:  (batch, seq_len, feature_dim)
            feature_dim = len(epsilon_range) * 2  (β₀ + β₁)  +  n_assets (residuals)
    Output: (batch, n_assets)  — refined weight vector (pre-softmax)
    """

    def __init__(self, feature_dim: int, n_assets: int, hidden: int = 128):
        super().__init__()
        if not _TORCH_AVAILABLE:
            raise RuntimeError("PyTorch is required for TopologyStrategyNet")
        self.feature_dim = feature_dim
        self.n_assets = n_assets
        self.lstm = nn.LSTM(feature_dim, hidden, num_layers=2, batch_first=True, dropout=0.2)
        self.head = nn.Sequential(
            nn.Linear(hidden, 64),
            nn.ReLU(),
            nn.Linear(64, n_assets),
            nn.Tanh(),    # outputs in [-1, 1] → scaled to long-only weights downstream
        )

    def forward(self, x: "torch.Tensor") -> "torch.Tensor":
        _, (h_n, _) = self.lstm(x)
        return self.head(h_n[-1])

    def predict_weights(self, x: "torch.Tensor") -> np.ndarray:
        """Predict and scale raw Tanh output to long-only weights summing to 1."""
        self.eval()
        with torch.no_grad():
            raw = self.forward(x)
        weights = torch.relu(raw).cpu().numpy()   # long-only: clip negatives
        row_sum = weights.sum(axis=-1, keepdims=True) + 1e-8
        return weights / row_sum


# ── Dataset loader ─────────────────────────────────────────────────────────────

@dataclass
class TopologySnapshot:
    timestamp: datetime
    tickers: list[str]
    betti_b0: np.ndarray          # (n_epsilon,)
    betti_b1: np.ndarray          # (n_epsilon,)
    laplacian_residuals: np.ndarray  # (n_assets,)
    realized_returns: Optional[np.ndarray] = None  # (n_assets,) — filled during training


def _to_datetime(ts) -> datetime:
    if isinstance(ts, datetime):
        return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
    return datetime.fromtimestamp(ts / 1000, tz=timezone.utc) if ts > 1e10 else datetime.fromtimestamp(ts, tz=timezone.utc)


async def load_backfill_data(db, months: int = 12) -> list[TopologySnapshot]:
    """
    Load topology snapshots from MongoDB for the past `months` months.
    Returns snapshots sorted by timestamp ascending.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=months * 30)
    cursor = db['topology_snapshots'].find(
        {'timestamp': {'$gte': cutoff}},
        sort=[('timestamp', 1)],
    )
    snapshots: list[TopologySnapshot] = []
    async for doc in cursor:
        betti = doc.get('betti_curves', {})
        b0 = np.array(betti.get('beta0', []), dtype=np.float32)
        b1 = np.array(betti.get('beta1', []), dtype=np.float32)
        residuals_map = doc.get('laplacian_residuals', {})
        tickers = doc.get('ticker_universe', list(residuals_map.keys()))
        residuals = np.array([residuals_map.get(t, 0.0) for t in tickers], dtype=np.float32)
        if len(b0) == 0 or len(residuals) == 0:
            continue
        snapshots.append(TopologySnapshot(
            timestamp=_to_datetime(doc['timestamp']),
            tickers=tickers,
            betti_b0=b0,
            betti_b1=b1,
            laplacian_residuals=residuals,
        ))
    log.info("Loaded %d topology snapshots for neural training", len(snapshots))
    return snapshots


def _attach_realized_returns(snapshots: list[TopologySnapshot], ohlcv_bars: list) -> list[TopologySnapshot]:
    """Attach next-period realized returns to each snapshot (required training signal)."""
    from collections import defaultdict

    # Build price map: timestamp_date → {ticker: close}
    price_map: dict[str, dict[str, float]] = defaultdict(dict)
    for bar in ohlcv_bars:
        dt = _to_datetime(bar['timestamp']).strftime('%Y-%m-%d')
        price_map[dt][bar['ticker']] = bar['close']

    filled = []
    dates = sorted(price_map.keys())
    date_idx = {d: i for i, d in enumerate(dates)}

    for snap in snapshots:
        snap_date = snap.timestamp.strftime('%Y-%m-%d')
        idx = date_idx.get(snap_date)
        if idx is None or idx + 1 >= len(dates):
            continue
        next_date = dates[idx + 1]
        returns = []
        for t in snap.tickers:
            p0 = price_map[snap_date].get(t)
            p1 = price_map[next_date].get(t)
            if p0 and p1 and p0 > 0:
                returns.append((p1 - p0) / p0)
            else:
                returns.append(0.0)
        snap.realized_returns = np.array(returns, dtype=np.float32)
        filled.append(snap)

    return filled


def _build_sequences(snapshots: list[TopologySnapshot], seq_len: int = 20) -> tuple[np.ndarray, np.ndarray, list[datetime]]:
    """
    Build (X, y) training pairs from time-ordered snapshots.
    X: (n_samples, seq_len, feature_dim)
    y: (n_samples, n_assets) — realized return ranks (Spearman IC target)
    """
    # Use the first snapshot to fix feature and asset dimensions
    ref = snapshots[0]
    n_epsilon = len(ref.betti_b0)
    n_assets  = len(ref.laplacian_residuals)
    feature_dim = n_epsilon * 2 + n_assets   # β₀ + β₁ + residuals

    xs, ys, timestamps = [], [], []
    for i in range(seq_len, len(snapshots)):
        window = snapshots[i - seq_len: i]
        target = snapshots[i]
        if target.realized_returns is None:
            continue
        # Pad / truncate to consistent n_assets (universe can change slightly)
        seq = []
        for s in window:
            b0 = s.betti_b0[:n_epsilon] if len(s.betti_b0) >= n_epsilon else np.pad(s.betti_b0, (0, n_epsilon - len(s.betti_b0)))
            b1 = s.betti_b1[:n_epsilon] if len(s.betti_b1) >= n_epsilon else np.pad(s.betti_b1, (0, n_epsilon - len(s.betti_b1)))
            res = s.laplacian_residuals[:n_assets] if len(s.laplacian_residuals) >= n_assets else np.pad(s.laplacian_residuals, (0, n_assets - len(s.laplacian_residuals)))
            seq.append(np.concatenate([b0, b1, res]).astype(np.float32))
        xs.append(np.stack(seq))          # (seq_len, feature_dim)
        ys.append(target.realized_returns[:n_assets] if len(target.realized_returns) >= n_assets
                  else np.pad(target.realized_returns, (0, n_assets - len(target.realized_returns))))
        timestamps.append(target.timestamp)

    if not xs:
        return np.zeros((0, seq_len, feature_dim)), np.zeros((0, n_assets)), []
    return np.stack(xs), np.stack(ys), timestamps


def _spearman_ic_loss(pred_weights: "torch.Tensor", realized_returns: "torch.Tensor") -> "torch.Tensor":
    """Differentiable surrogate: negative mean rank correlation (MSE on rank-scaled values)."""
    # Simple MSE on return ranks as a differentiable proxy for Spearman IC
    n = realized_returns.shape[-1]
    ranks = torch.argsort(torch.argsort(realized_returns, dim=-1), dim=-1).float() / (n - 1 + 1e-8)
    return torch.mean((pred_weights - ranks) ** 2)


# ── Walk-forward trainer ───────────────────────────────────────────────────────

@dataclass
class TrainingResult:
    version_id: str
    oos_ic_mean: float
    oos_ic_std: float
    oos_sharpe: float
    validation_passed: bool
    model_bytes: bytes              # serialised model state_dict (pickle)
    calibrator_bytes: bytes         # serialised IsotonicRegression (pickle)
    n_train_samples: int
    fold_ics: list[float]


def _train_single_fold(
    X_train: np.ndarray,
    y_train: np.ndarray,
    X_test: np.ndarray,
    y_test: np.ndarray,
    feature_dim: int,
    n_assets: int,
    epochs: int = 50,
    lr: float = 1e-3,
) -> tuple[TopologyStrategyNet, list[float]]:
    if not _TORCH_AVAILABLE:
        raise RuntimeError("PyTorch is required")

    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    model = TopologyStrategyNet(feature_dim=feature_dim, n_assets=n_assets).to(device)
    optimizer = optim.Adam(model.parameters(), lr=lr)

    X_tr = torch.tensor(X_train, dtype=torch.float32).to(device)
    y_tr = torch.tensor(y_train, dtype=torch.float32).to(device)

    model.train()
    for epoch in range(epochs):
        optimizer.zero_grad()
        pred = model(X_tr)
        loss = _spearman_ic_loss(pred, y_tr)
        loss.backward()
        optimizer.step()

    # OOS IC evaluation
    X_te = torch.tensor(X_test, dtype=torch.float32).to(device)
    y_te = y_test
    oos_ics = []
    model.eval()
    with torch.no_grad():
        preds = model(X_te).cpu().numpy()
    for i in range(len(preds)):
        if np.std(preds[i]) > 0 and np.std(y_te[i]) > 0:
            ic, _ = spearmanr(preds[i], y_te[i])
            oos_ics.append(float(ic))

    return model, oos_ics


def train_neural_strategy(
    snapshots: list[TopologySnapshot],
    seq_len: int = 20,
    epochs: int = 50,
    ic_threshold: float = 0.02,   # minimum mean OOS IC to pass validation
) -> Optional[TrainingResult]:
    """
    Walk-forward training with 21-day embargo.
    Returns TrainingResult if validation passes, None otherwise.
    """
    if not _TORCH_AVAILABLE:
        log.error("PyTorch not available — cannot train TopologyStrategyNet")
        return None

    X, y, timestamps = _build_sequences(snapshots, seq_len=seq_len)
    if len(X) < MIN_SAMPLES:
        log.warning("Insufficient training samples (%d < %d) — aborting neural training", len(X), MIN_SAMPLES)
        return None

    n_samples, _, feature_dim = X.shape
    n_assets = y.shape[1]
    fold_size = n_samples // (N_FOLDS + 1)

    all_ics: list[float] = []
    all_fold_ics: list[float] = []
    best_model: Optional[TopologyStrategyNet] = None

    for fold in range(N_FOLDS):
        train_end_idx = (fold + 1) * fold_size
        # Apply 21-day embargo: skip samples whose timestamp is within EMBARGO_DAYS of train_end
        embargo_cutoff = timestamps[train_end_idx - 1] + timedelta(days=EMBARGO_DAYS) if train_end_idx <= len(timestamps) else None
        if embargo_cutoff is None:
            continue

        test_start_idx = train_end_idx
        while test_start_idx < len(timestamps) and timestamps[test_start_idx] < embargo_cutoff:
            test_start_idx += 1
        test_end_idx = min(test_start_idx + fold_size, n_samples)

        if test_start_idx >= test_end_idx or train_end_idx < seq_len:
            continue

        X_train, y_train = X[:train_end_idx], y[:train_end_idx]
        X_test,  y_test  = X[test_start_idx:test_end_idx], y[test_start_idx:test_end_idx]

        if len(X_train) < 50 or len(X_test) < 10:
            continue

        model, fold_ics = _train_single_fold(X_train, y_train, X_test, y_test, feature_dim, n_assets, epochs=epochs)
        all_ics.extend(fold_ics)
        fold_mean = float(np.mean(fold_ics)) if fold_ics else 0.0
        all_fold_ics.append(fold_mean)
        if best_model is None or fold_mean > (np.mean(all_fold_ics[:-1]) if len(all_fold_ics) > 1 else -999):
            best_model = model

        log.info("Fold %d/%d — OOS IC mean=%.4f n=%d", fold + 1, N_FOLDS, fold_mean, len(fold_ics))

    if not all_ics or best_model is None:
        log.error("No valid folds produced — neural training failed")
        return None

    oos_ic_mean = float(np.mean(all_ics))
    oos_ic_std  = float(np.std(all_ics))
    # Approximate OOS Sharpe from IC: Sharpe ≈ IC * sqrt(n_periods_per_year / turnover)
    oos_sharpe  = oos_ic_mean * np.sqrt(52) / max(oos_ic_std, 1e-6)

    validation_passed = oos_ic_mean >= ic_threshold and oos_sharpe >= 0.5

    # Isotonic calibration: fit on all OOS IC values mapped to binary signal success
    calibrator = IsotonicRegression(out_of_bounds='clip')
    if len(all_ics) >= 10:
        binary = (np.array(all_ics) > 0).astype(float)
        calibrator.fit(np.array(all_ics), binary)

    model_bytes      = pickle.dumps(best_model.state_dict())
    calibrator_bytes = pickle.dumps(calibrator)

    result = TrainingResult(
        version_id=str(uuid.uuid4()),
        oos_ic_mean=oos_ic_mean,
        oos_ic_std=oos_ic_std,
        oos_sharpe=oos_sharpe,
        validation_passed=validation_passed,
        model_bytes=model_bytes,
        calibrator_bytes=calibrator_bytes,
        n_train_samples=len(X),
        fold_ics=all_fold_ics,
    )

    log.info(
        "Neural strategy training complete — OOS IC=%.4f Sharpe=%.2f passed=%s",
        oos_ic_mean, oos_sharpe, validation_passed,
    )
    return result


# ── Shadow test registration ───────────────────────────────────────────────────

async def register_shadow_version(db, result: TrainingResult) -> str:
    """
    Persist training result as a shadow-test version in ModelVersionStore.
    Returns the version_id. Admin must call promote_to_live after 30 days.
    """
    from ..infrastructure.model_store_client import ModelStoreClient
    store = ModelStoreClient(db)
    await store.save_neural_version(
        version_id=result.version_id,
        strategy_id='topology_neural_v1',
        oos_sharpe=result.oos_sharpe,
        oos_ic=result.oos_ic_mean,
        validation_passed=result.validation_passed,
        model_bytes=result.model_bytes,
        calibrator_bytes=result.calibrator_bytes,
        metadata={
            'fold_ics':         result.fold_ics,
            'n_train_samples':  result.n_train_samples,
            'oos_ic_std':       result.oos_ic_std,
            'embargo_days':     EMBARGO_DAYS,
        },
    )
    log.info("Registered shadow version %s (30-day clock starts now)", result.version_id)
    return result.version_id


# ── Inference helper ────────────────────────────────────────────────────────────

def load_model(model_bytes: bytes, feature_dim: int, n_assets: int) -> "TopologyStrategyNet":
    if not _TORCH_AVAILABLE:
        raise RuntimeError("PyTorch required for inference")
    model = TopologyStrategyNet(feature_dim=feature_dim, n_assets=n_assets)
    state_dict = pickle.loads(model_bytes)
    model.load_state_dict(state_dict)
    model.eval()
    return model
