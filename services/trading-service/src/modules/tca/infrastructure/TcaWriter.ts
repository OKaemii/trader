import { getMidQuote } from '@trader/shared-bars';
import { getPgPool } from '@trader/shared-pg';
import { computeSlippage } from '../application/slippage.ts';

// Fan-out from each observed fill: join the mid-quote at the order's arrival and at fill time,
// compute slippage (pure), and append one tca_log row. Best-effort — a missing quote yields
// null slippage rather than skipping the row, so coverage is measurable. Implements the
// `TcaRecorder` interface FillsPoller consumes.
export interface TcaInput {
  fillId: string;
  orderId: string;
  signalId: string | null;
  ticker: string;
  side: 'BUY' | 'SELL';
  filledQty: number;
  fillPrice: number;
  filledAtMs: number;
  arrivalAtMs: number | null;
}

const TCA_QUOTE_FRESHNESS_MS = 15 * 60_000;

export class TcaWriter {
  async record(input: TcaInput): Promise<void> {
    const [arrivalQ, fillQ] = await Promise.all([
      input.arrivalAtMs != null
        ? getMidQuote(input.ticker, { asOf: input.arrivalAtMs, freshnessMs: TCA_QUOTE_FRESHNESS_MS }).catch(() => null)
        : Promise.resolve(null),
      getMidQuote(input.ticker, { asOf: input.filledAtMs, freshnessMs: TCA_QUOTE_FRESHNESS_MS }).catch(() => null),
    ]);

    const slip = computeSlippage({
      side: input.side,
      fillPrice: input.fillPrice,
      arrivalMid: arrivalQ?.mid ?? null,
      fillMid: fillQ?.mid ?? null,
    });

    const pool = getPgPool();
    await pool.query(
      `INSERT INTO tca_log
         (fill_id, order_id, signal_id, ticker, side, arrival_at, fill_at, filled_qty,
          fill_price, arrival_mid, fill_mid, arrival_slip_bps, fill_slip_bps, total_cost_bps,
          quote_arrival_source, quote_fill_source)
       VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7/1000.0),$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (fill_id, computed_at) DO NOTHING`,
      [
        input.fillId, input.orderId, input.signalId, input.ticker, input.side,
        input.arrivalAtMs != null ? new Date(input.arrivalAtMs) : null,
        input.filledAtMs, input.filledQty, input.fillPrice,
        arrivalQ?.mid ?? null, fillQ?.mid ?? null,
        slip.arrivalSlipBps, slip.fillSlipBps, slip.totalCostBps,
        arrivalQ?.source ?? null, fillQ?.source ?? null,
      ],
    );
  }
}
