import { randomUUID } from 'node:crypto';
import type { T212Cash, T212Position } from '../../t212/infrastructure/Trading212Client.ts';
import type { NavSnapshot } from '../infrastructure/ReconciliationStore.ts';
import {
  DEFAULT_THRESHOLDS,
  type Finding,
  type OrderView,
  type PositionView,
  type Thresholds,
  cashCheck,
  fillsCheck,
  ordersCheck,
  positionsCheck,
} from './ReconciliationChecks.ts';

export interface ReconcileWindow {
  startMs: number;
  endMs: number;
  trigger: 'scheduled_4h' | 'scheduled_nightly' | 'manual' | 'pod_catchup';
}

// Broker truth (subset of Trading212Client).
export interface BrokerLike {
  getPositions(): Promise<T212Position[]>;
  getCash(): Promise<T212Cash>;
}

// History walk (T212HistoryWalker satisfies this).
export interface HistoryWalkerLike {
  walkRange(startMs: number, endMs: number): Promise<{ items: import('../../t212/infrastructure/Trading212Client.ts').T212HistoryItem[]; complete: boolean }>;
}

// Append-only ledger (ReconciliationStore satisfies this).
export interface LedgerLike {
  writeFinding(cycleId: string, occurredAt: Date, effectiveAt: Date, f: Finding): Promise<void>;
  writeNav(snapshotAt: Date, nav: NavSnapshot): Promise<void>;
  readPriorCash(): Promise<number | null>;
}

// System state (Mongo) — read as minimal views so the engine doesn't couple to doc schemas.
export interface SystemReader {
  positions(): Promise<PositionView[]>;
  submittedOrders(): Promise<OrderView[]>;
  ledgerFillIds(startMs: number, endMs: number): Promise<string[]>;
  // Of the given T212 order ids, which the system has a record of (ANY status). Used to
  // distinguish genuine out-of-band orders from the system's own (already-filled) orders.
  knownOrderIds(t212OrderIds: string[]): Promise<Set<string>>;
}

// The ONLY money-touching writes, isolated behind an interface and gated by autoHealEnabled.
export interface Healer {
  healPositionQuantity(ticker: string, brokerQty: number, cycleId: string): Promise<void>;
  healOrderState(orderId: string, cycleId: string): Promise<void>;
}

export interface Alerter {
  notify(payload: { cycleId: string; count: number; findings: Finding[] }): Promise<void>;
}

// Positions value in GBP (FX-aware) — injected so the engine stays FX-agnostic.
export type PositionsValuerGbp = (positions: T212Position[]) => Promise<number>;

export interface ReconciliationDeps {
  broker: BrokerLike;
  history: HistoryWalkerLike;
  system: SystemReader;
  store: LedgerLike;
  healer: Healer;
  alerter: Alerter;
  valuePositionsGbp: PositionsValuerGbp;
  thresholds?: Thresholds;
  /** Default false → observe-only: findings + NAV recorded, NO mutations. Flip on once trusted. */
  autoHealEnabled?: boolean;
}

export interface RunSummary {
  cycleId: string;
  findings: number;
  healed: number;
  majors: number;
  autoHealEnabled: boolean;
  historyComplete: boolean;
}

export class Reconciliation {
  private readonly thresholds: Thresholds;
  private readonly autoHeal: boolean;

  constructor(private readonly deps: ReconciliationDeps) {
    this.thresholds = deps.thresholds ?? DEFAULT_THRESHOLDS;
    this.autoHeal = deps.autoHealEnabled ?? false;
  }

  async run(window: ReconcileWindow): Promise<RunSummary> {
    const cycleId = randomUUID();
    const occurredAt = new Date();
    const effectiveAt = new Date(window.endMs);

    const [t212Positions, t212Cash, history] = await Promise.all([
      this.deps.broker.getPositions(),
      this.deps.broker.getCash(),
      this.deps.history.walkRange(window.startMs, window.endMs),
    ]);
    const [sysPositions, sysOrders, ledgerFillIds, priorCash] = await Promise.all([
      this.deps.system.positions(),
      this.deps.system.submittedOrders(),
      this.deps.system.ledgerFillIds(window.startMs, window.endMs),
      this.deps.store.readPriorCash(),
    ]);

    const brokerPositions: PositionView[] = t212Positions.map((p) => ({
      ticker: p.ticker, quantity: p.quantity, avgPrice: p.averagePrice.amount,
    }));
    const brokerCash = { free: t212Cash.free.amount, total: t212Cash.total.amount };
    const brokerOrders = history.items.map((h) => ({
      orderId: String(h.order.id), ticker: h.order.ticker, status: h.order.status,
    }));
    const brokerFills = history.items
      .filter((h) => h.fill)
      .map((h) => ({ fillId: String(h.fill!.id), orderId: String(h.order.id) }));

    // Which T212 orders the system actually has a record of (any status) — so a filled order
    // isn't mistaken for out-of-band, and a missing-fill only counts for orders we placed.
    const knownOrderIds = await this.deps.system.knownOrderIds(brokerOrders.map((o) => o.orderId));

    const findings: Finding[] = [
      ...positionsCheck(sysPositions, brokerPositions, this.thresholds),
      ...cashCheck(brokerCash, priorCash, this.thresholds),
      ...ordersCheck(sysOrders, brokerOrders, knownOrderIds),
      ...fillsCheck(ledgerFillIds, brokerFills, knownOrderIds),
    ];

    for (const f of findings) {
      await this.deps.store.writeFinding(cycleId, occurredAt, effectiveAt, f);
    }

    const positionsValue = await this.deps.valuePositionsGbp(t212Positions);
    await this.deps.store.writeNav(occurredAt, {
      cash: brokerCash.total, positionsValue, nav: brokerCash.total + positionsValue,
    });

    let healed = 0;
    if (this.autoHeal) {
      for (const f of findings) {
        if (!f.autoHealable) continue;
        if (f.driftType === 'position_drift' && f.ticker) {
          await this.deps.healer.healPositionQuantity(f.ticker, Number(f.brokerState.quantity ?? 0), cycleId);
          healed += 1;
        } else if (f.driftType === 'order_state_drift' && history.complete) {
          // Order-state heal trusts the broker's terminal status — only when the history
          // walk was complete (otherwise the "terminal" view may be partial).
          await this.deps.healer.healOrderState(String(f.systemState.orderId ?? ''), cycleId);
          healed += 1;
        }
      }
    }

    const majors = findings.filter((f) => f.severity === 'major');
    if (majors.length > 0) {
      await this.deps.alerter.notify({ cycleId, count: majors.length, findings: majors });
    }

    return {
      cycleId,
      findings: findings.length,
      healed,
      majors: majors.length,
      autoHealEnabled: this.autoHeal,
      historyComplete: history.complete,
    };
  }
}
