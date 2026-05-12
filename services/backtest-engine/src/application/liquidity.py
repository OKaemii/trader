class LiquidityConstraint:
    max_adv_participation: float = 0.05    # 5% of ADV
    min_adv_usd: float = 1_000_000        # reject instruments with < $1M ADV

    def max_position_usd(self, adv_usd: float) -> float:
        return 0.0 if adv_usd < self.min_adv_usd else adv_usd * self.max_adv_participation
