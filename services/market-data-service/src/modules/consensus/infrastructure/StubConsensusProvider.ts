// Analyst-consensus provider — STUBBED placeholder (plan ## Task 12, "Pipeline C ships STUBBED,
// EODHD-swap-ready"). No consensus vendor is wired, so this provider has no estimates/actuals for any
// ticker and returns an empty map. A proper earnings surprise REQUIRES consensus and is "not built
// rather than faked" — with this stub the consensus_estimate / earnings_surprise stores never accrete
// a row, and the routes serve the honest empty shape. Swapping in an `EodhdConsensusProvider` (or a
// gold-standard vendor) later is a one-provider change in wiring.ts, untouched by this file.

import type { ConsensusProvider, ConsensusData } from './ConsensusProvider.ts';

export class StubConsensusProvider implements ConsensusProvider {
    /** No consensus is available — every ticker is omitted (an empty map, never a fabricated estimate). */
    async fetch(_tickers: string[]): Promise<Record<string, ConsensusData>> {
        return {};
    }
}
