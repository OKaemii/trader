// Pure TCA slippage math (no I/O). Side-aware so a "cost" is always positive when the fill
// is worse than the reference: for a BUY, paying above mid is a cost (+); for a SELL, selling
// below mid is a cost (+). Null mids (no fresh quote at that instant) → null slippage; the
// dashboard excludes nulls and shows the coverage rate.
export interface SlippageInput {
  side: 'BUY' | 'SELL';
  fillPrice: number;
  arrivalMid: number | null;
  fillMid: number | null;
}

export interface Slippage {
  arrivalSlipBps: number | null;   // mid move from order-send to fill (adverse selection)
  fillSlipBps: number | null;      // fill vs mid at fill (effective half-spread paid)
  totalCostBps: number | null;     // fill vs mid at arrival (all-in)
}

const bps = (a: number, b: number): number => (10000 * (a - b)) / b;

export function computeSlippage(input: SlippageInput): Slippage {
  const sign = input.side === 'BUY' ? 1 : -1;
  const { fillPrice, arrivalMid, fillMid } = input;
  return {
    arrivalSlipBps: arrivalMid != null && fillMid != null && arrivalMid > 0 ? sign * bps(fillMid, arrivalMid) : null,
    fillSlipBps: fillMid != null && fillMid > 0 ? sign * bps(fillPrice, fillMid) : null,
    totalCostBps: arrivalMid != null && arrivalMid > 0 ? sign * bps(fillPrice, arrivalMid) : null,
  };
}
