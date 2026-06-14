// Consensus composition root (Pipeline C — plan ## Task 12). Selects the ConsensusProvider by
// `CONSENSUS_PROVIDER` (default 'stub'). No consensus vendor is wired, so every value currently
// resolves to the StubConsensusProvider, which returns {} for every name → the consensus_estimate /
// earnings_surprise stores stay empty and the surprise/revision fields render the honest
// "requires consensus — not sourced" state.
//
// This is the SINGLE swap point: wiring an `EodhdConsensusProvider` (EODHD's Fundamentals Data Feed
// carries analyst estimates for US names) or a gold-standard vendor (FactSet/Bloomberg/LSEG) later is
// one `case` here — the store, routes, and collections are untouched. The interface guarantees a
// mechanical SUE/EAR proxy can never masquerade as a proper surprise: a surprise row is only ever
// derived from a real consensus_eps + actual_eps pair (ConsensusStore.refresh → surprisePct).

import { ConsensusStore } from './application/ConsensusStore.ts';
import { StubConsensusProvider } from './infrastructure/StubConsensusProvider.ts';
import type { ConsensusProvider } from './infrastructure/ConsensusProvider.ts';
import { log } from '../../logger.ts';

export function buildConsensusStore(providerName: 'stub' | 'eodhd'): ConsensusStore {
    let provider: ConsensusProvider;
    let source: string;
    switch (providerName) {
        // case 'eodhd': provider = new EodhdConsensusProvider(...); source = 'eodhd'; break;
        case 'stub':
        default:
            if (providerName !== 'stub') {
                log.warn(`[consensus] provider '${providerName}' not implemented; using the no-op stub`);
            }
            // The stub never returns an estimate, so no doc is ever written with this source stamp.
            provider = new StubConsensusProvider();
            source = 'stub';
            break;
    }
    return new ConsensusStore(provider, source);
}
