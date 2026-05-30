// Pure three-way reconciliation checks. NO I/O — each takes minimal *view* types (not the
// volatile Mongo/T212 concrete shapes) and returns Finding[]. The engine (Reconciliation.ts)
// adapts real docs/responses to these views, so the checks depend on stable abstractions and
// are trivially unit-testable.

export type DriftType =
  | 'position_drift' | 'oob_position'
  | 'cash_drift'
  | 'order_state_drift' | 'oob_order'
  | 'missing_fill' | 'duplicate_fill';

export type DriftSeverity = 'clean' | 'minor' | 'major' | 'error';

export interface Finding {
  ticker: string | null;
  driftType: DriftType | null;   // null when isClean
  severity: DriftSeverity;
  isClean: boolean;
  systemState: Record<string, unknown>;
  brokerState: Record<string, unknown>;
  auditState: Record<string, unknown>;
  diff: Record<string, unknown>;
  threshold: Record<string, unknown>;
  autoHealable: boolean;
}

export interface Thresholds {
  positionDriftSharesAuto: number;   // ≤ this → auto-heal positions
  positionDriftSharesAlert: number;  // > this → major (page)
  cashDriftAlertAmount: number;      // GBP; cash never auto-heals, this just sets severity
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  positionDriftSharesAuto: 1,
  positionDriftSharesAlert: 10,
  cashDriftAlertAmount: 10.0,
};

// ── View types (minimal, stable) ────────────────────────────────────────────────
export interface PositionView { ticker: string; quantity: number; avgPrice?: number }
export interface CashView { free: number; total: number }
export interface OrderView { orderId: string; ticker: string; side: 'BUY' | 'SELL'; status: string; signalId?: string | null }
export interface BrokerOrderView { orderId: string; ticker: string; status: string; signalId?: string | null }

function cleanRow(ticker: string | null, system: unknown, broker: unknown): Finding {
  return {
    ticker, driftType: null, severity: 'clean', isClean: true,
    systemState: (system ?? {}) as Record<string, unknown>,
    brokerState: (broker ?? {}) as Record<string, unknown>,
    auditState: {}, diff: {}, threshold: {}, autoHealable: false,
  };
}

// ── positions: Mongo vs T212. Auto-heal only ≤ positionDriftSharesAuto; OOB never. ──
export function positionsCheck(
  system: PositionView[],
  broker: PositionView[],
  thresholds: Thresholds,
): Finding[] {
  const out: Finding[] = [];
  const sysByTicker = new Map(system.map((p) => [p.ticker, p]));
  const brkByTicker = new Map(broker.map((p) => [p.ticker, p]));
  const tickers = new Set<string>([...sysByTicker.keys(), ...brkByTicker.keys()]);

  for (const ticker of tickers) {
    const s = sysByTicker.get(ticker);
    const b = brkByTicker.get(ticker);
    const sQty = s?.quantity ?? 0;
    const bQty = b?.quantity ?? 0;
    const delta = Math.abs(sQty - bQty);

    if (delta < 1e-6) {
      out.push(cleanRow(ticker, s, b));
      continue;
    }
    if (!s && b) {
      // T212 holds shares the system never recorded — out-of-band trade. Operator decides
      // signal attribution; never auto-heal.
      out.push({
        ticker, driftType: 'oob_position', severity: 'major', isClean: false,
        systemState: {}, brokerState: b as unknown as Record<string, unknown>, auditState: {},
        diff: { systemQty: 0, brokerQty: bQty },
        threshold: { observed: bQty }, autoHealable: false,
      });
      continue;
    }
    const severity: DriftSeverity = delta <= thresholds.positionDriftSharesAlert ? 'minor' : 'major';
    out.push({
      ticker, driftType: 'position_drift', severity, isClean: false,
      systemState: (s ?? {}) as unknown as Record<string, unknown>,
      brokerState: (b ?? {}) as unknown as Record<string, unknown>,
      auditState: {},
      diff: { systemQty: sQty, brokerQty: bQty, delta },
      threshold: { observed: delta, auto: thresholds.positionDriftSharesAuto, alert: thresholds.positionDriftSharesAlert },
      autoHealable: delta <= thresholds.positionDriftSharesAuto,
    });
  }
  return out;
}

// ── cash: compare T212 cash to the prior NAV snapshot's cash. NEVER auto-heal. ──
export function cashCheck(
  brokerCash: CashView,
  priorCash: number | null,
  thresholds: Thresholds,
): Finding[] {
  if (priorCash === null) {
    // Day-1 baseline — nothing to compare against.
    return [cleanRow(null, { cash: null }, { cash: brokerCash.total })];
  }
  const delta = Math.abs(brokerCash.total - priorCash);
  if (delta < 1e-6) return [cleanRow(null, { cash: priorCash }, { cash: brokerCash.total })];
  return [{
    ticker: null, driftType: 'cash_drift',
    severity: delta >= thresholds.cashDriftAlertAmount ? 'major' : 'minor',
    isClean: false,
    systemState: { priorCash }, brokerState: { cash: brokerCash.total, free: brokerCash.free },
    auditState: {},
    diff: { priorCash, brokerCash: brokerCash.total, delta },
    threshold: { observed: delta, alert: thresholds.cashDriftAlertAmount },
    autoHealable: false,   // corporate actions / fees / wires — never auto-correct
  }];
}

// A broker fill identified by its T212 fill id and the T212 order id it belongs to.
export interface BrokerFill { fillId: string; orderId: string }

// ── orders: Mongo 'submitted' vs T212 terminal history; T212 orders the system never placed. ──
// `knownOrderIds` is the set of T212 order ids the system HAS a record of, in ANY status. A
// filled order is NOT out-of-band — the earlier bug compared only against currently-submitted
// orders, so every order that had already filled flooded the list as oob_order.
export function ordersCheck(
  systemOrders: OrderView[],
  brokerOrders: BrokerOrderView[],
  knownOrderIds: Set<string>,
): Finding[] {
  const out: Finding[] = [];
  const brkById = new Map(brokerOrders.map((o) => [o.orderId, o]));

  // order_state_drift: a still-'submitted' system order that the broker says is terminal.
  for (const o of systemOrders) {
    if (o.status !== 'submitted') continue;
    const b = brkById.get(o.orderId);
    if (b && (b.status === 'CANCELLED' || b.status === 'REJECTED' || b.status === 'EXPIRED')) {
      out.push({
        ticker: o.ticker, driftType: 'order_state_drift', severity: 'minor', isClean: false,
        systemState: { orderId: o.orderId, status: o.status },
        brokerState: { orderId: b.orderId, status: b.status }, auditState: {},
        diff: { systemStatus: o.status, brokerStatus: b.status },
        threshold: {},
        autoHealable: true,   // flip Mongo to cancelled — safe, broker is truth
      });
    }
  }

  // oob_order: a T212 order the system has NO record of (any status) → genuine out-of-band
  // (manual T212 trade, or system order history lost to a data wipe).
  for (const b of brokerOrders) {
    if (!knownOrderIds.has(b.orderId)) {
      out.push({
        ticker: b.ticker, driftType: 'oob_order', severity: 'major', isClean: false,
        systemState: {}, brokerState: { orderId: b.orderId, status: b.status }, auditState: {},
        diff: { brokerOrderId: b.orderId }, threshold: {}, autoHealable: false,
      });
    }
  }
  return out;
}

// ── fills: ledger fill_ids vs T212 fills. A "missing" fill is only meaningful for an order the
// system actually placed (knownOrderIds): we expected a ledger row and it's absent. Fills for
// unknown orders are out-of-band (covered by oob_order), NOT missing — counting them flooded
// the list because the ledger starts empty and accrues only post-deploy fills. ──
export function fillsCheck(
  ledgerFillIds: string[],
  brokerFills: BrokerFill[],
  knownOrderIds: Set<string>,
): Finding[] {
  const out: Finding[] = [];
  const ledger = new Set(ledgerFillIds);

  // Duplicates within the ledger.
  const seen = new Set<string>();
  for (const id of ledgerFillIds) {
    if (seen.has(id)) {
      out.push({
        ticker: null, driftType: 'duplicate_fill', severity: 'major', isClean: false,
        systemState: { fillId: id }, brokerState: {}, auditState: { fillId: id },
        diff: { duplicateFillId: id }, threshold: {}, autoHealable: false,
      });
    }
    seen.add(id);
  }

  // T212 fills for KNOWN system orders that never reached the ledger.
  for (const f of brokerFills) {
    if (knownOrderIds.has(f.orderId) && !ledger.has(f.fillId)) {
      out.push({
        ticker: null, driftType: 'missing_fill', severity: 'major', isClean: false,
        systemState: { orderId: f.orderId }, brokerState: { fillId: f.fillId }, auditState: {},
        diff: { missingFillId: f.fillId, orderId: f.orderId }, threshold: {}, autoHealable: false,
      });
    }
  }
  return out;
}
