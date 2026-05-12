import { SignalFeed } from '@/components/SignalFeed';
import { BettiCurveChart } from '@/components/BettiCurveChart';
import { FactorExposureChart } from '@/components/FactorExposureChart';
import { RegimeWidget } from '@/components/RegimeWidget';
import { StrategyHealthBanner } from '@/components/StrategyHealthBanner';

export default function SignalsPage() {
  return (
    <div className="grid grid-cols-2 gap-6 p-6 bg-gray-950 min-h-screen">
      <div className="col-span-2">
        <h1 className="text-2xl font-bold text-white">Trade Signals</h1>
        <p className="text-gray-400 text-sm mt-1">
          Signals are generated weekly. Paper mode — no automated orders.
        </p>
      </div>
      <StrategyHealthBanner />
      <div className="col-span-2 md:col-span-1">
        <SignalFeed />
      </div>
      <div className="col-span-2 md:col-span-1 flex flex-col gap-4">
        <RegimeWidget />
        <FactorExposureChart />
        <BettiCurveChart />
      </div>
    </div>
  );
}
