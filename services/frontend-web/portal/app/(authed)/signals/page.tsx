import { SignalFeed } from '@/components/SignalFeed';
import { BettiCurveChart } from '@/components/BettiCurveChart';
import { FactorExposureChart } from '@/components/FactorExposureChart';
import { RegimeWidget } from '@/components/RegimeWidget';
import { StrategyHealthBanner } from '@/components/StrategyHealthBanner';

export default function SignalsPage() {
  return (
    <div className="grid grid-cols-2 gap-6 p-6">
      <div className="col-span-2">
        <h1 className="text-2xl font-bold text-white">Trade Signals</h1>
        <p className="mt-1 text-sm text-gray-400">
          Signals are generated weekly. Paper mode — no automated orders. Live P&amp;L vs. entry price; weight bar shows fill progress.
        </p>
      </div>
      <StrategyHealthBanner />
      <div className="col-span-2 md:col-span-1">
        <SignalFeed />
      </div>
      <div className="col-span-2 flex flex-col gap-4 md:col-span-1">
        <RegimeWidget />
        <FactorExposureChart />
        <BettiCurveChart />
      </div>
    </div>
  );
}
