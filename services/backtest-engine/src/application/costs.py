import numpy as np
from dataclasses import dataclass


@dataclass
class TransactionCostModel:
    half_spread_bps:    float = 5.0   # bid-ask half-spread
    market_impact_bps:  float = 10.0  # per unit of ADV participation
    borrow_rate_annual: float = 0.03  # 3% annual borrow for shorts
    commission_bps:     float = 1.0

    def total_cost_bps(self, trade_size: float, adv: float,
                       is_short: bool = False, holding_days: int = 1) -> float:
        participation = trade_size / adv if adv > 0 else 0.1
        impact = self.market_impact_bps * np.sqrt(participation)
        borrow = (self.borrow_rate_annual * 10_000 / 252) * holding_days if is_short else 0.0
        return self.half_spread_bps + impact + self.commission_bps + borrow

    def net_return(self, gross_pnl: float, trade_size: float, adv: float,
                   is_short: bool = False, holding_days: int = 1) -> float:
        cost_frac = self.total_cost_bps(trade_size, adv, is_short, holding_days) / 10_000
        return gross_pnl - cost_frac * trade_size


def impact_cost_bps(trade_usd: float, adv_usd: float, volatility: float, eta: float = 0.1) -> float:
    """Almgren-Chriss square-root permanent impact in basis points."""
    if adv_usd == 0:
        return float('inf')
    participation = trade_usd / adv_usd
    return eta * volatility * (participation ** 0.5) * 10_000
