import { describe, it, expect } from 'vitest';
import { money } from '@trader/shared-types';
import { Reconciliation, type ReconciliationDeps } from '../modules/reconciliation/application/Reconciliation.ts';
import type { Finding } from '../modules/reconciliation/application/ReconciliationChecks.ts';
import type { T212Cash, T212Position, T212HistoryItem } from '../modules/t212/infrastructure/Trading212Client.ts';

const WINDOW = { startMs: 0, endMs: 10_000, trigger: 'manual' as const };

function pos(ticker: string, quantity: number): T212Position {
  return { ticker, quantity, averagePrice: money(10, 'GBP'), currentPrice: money(11, 'GBP'), currentValue: money(11 * quantity, 'GBP') };
}
const CASH: T212Cash = { free: money(500, 'GBP'), total: money(1000, 'GBP') };

function makeDeps(over: Partial<ReconciliationDeps> & {
  brokerPositions?: T212Position[]; sysPositions?: { ticker: string; quantity: number }[];
  historyItems?: T212HistoryItem[]; historyComplete?: boolean; priorCash?: number | null;
} = {}) {
  const healCalls: string[] = [];
  const orderHealCalls: string[] = [];
  const alerts: number[] = [];
  const findingsWritten: Finding[] = [];
  let navWrites = 0;
  let lastNav: { cash: number; positionsValue: number; nav: number } | null = null;

  const deps: ReconciliationDeps = {
    broker: {
      getPositions: async () => over.brokerPositions ?? [pos('AAPL_US_EQ', 10)],
      getCash: async () => CASH,
    },
    history: {
      walkRange: async () => ({ items: over.historyItems ?? [], complete: over.historyComplete ?? true }),
    },
    system: {
      positions: async () => over.sysPositions ?? [{ ticker: 'AAPL_US_EQ', quantity: 10 }],
      submittedOrders: async () => [],
      ledgerFillIds: async () => [],
      knownOrderIds: async () => new Set<string>(),
    },
    store: {
      writeFinding: async (_c, _o, _e, f) => { findingsWritten.push(f); },
      writeNav: async (_at, n) => { navWrites += 1; lastNav = n; },
      readPriorCash: async () => (over.priorCash === undefined ? 1000 : over.priorCash),
    },
    healer: {
      healPositionQuantity: async (t) => { healCalls.push(t); },
      healOrderState: async (o) => { orderHealCalls.push(o); },
    },
    alerter: { notify: async (p) => { alerts.push(p.count); } },
    valuePositionsGbp: async () => 110,
    autoHealEnabled: over.autoHealEnabled,
  };
  return { deps, healCalls, orderHealCalls, alerts, findingsWritten, navWrites: () => navWrites, lastNav: () => lastNav };
}

describe('Reconciliation engine', () => {
  it('observe-only by default: drift recorded + NAV written, NO heal', async () => {
    const h = makeDeps({ sysPositions: [{ ticker: 'AAPL_US_EQ', quantity: 100 }], brokerPositions: [pos('AAPL_US_EQ', 99.5)] });
    const summary = await new Reconciliation(h.deps).run(WINDOW);
    expect(summary.autoHealEnabled).toBe(false);
    expect(summary.healed).toBe(0);
    expect(h.healCalls).toHaveLength(0);
    expect(h.navWrites()).toBe(1);
    expect(h.findingsWritten.some((f) => f.driftType === 'position_drift')).toBe(true);
  });

  it('auto-heal ON heals sub-threshold position drift', async () => {
    const h = makeDeps({
      autoHealEnabled: true,
      sysPositions: [{ ticker: 'AAPL_US_EQ', quantity: 100 }], brokerPositions: [pos('AAPL_US_EQ', 99.5)],
    });
    const summary = await new Reconciliation(h.deps).run(WINDOW);
    expect(h.healCalls).toEqual(['AAPL_US_EQ']);
    expect(summary.healed).toBe(1);
  });

  it('never heals above the alert threshold (major) and pages', async () => {
    const h = makeDeps({
      autoHealEnabled: true,
      sysPositions: [{ ticker: 'AAPL_US_EQ', quantity: 100 }], brokerPositions: [pos('AAPL_US_EQ', 80)],
    });
    const summary = await new Reconciliation(h.deps).run(WINDOW);
    expect(h.healCalls).toHaveLength(0);
    expect(summary.majors).toBeGreaterThanOrEqual(1);
    expect(h.alerts.length).toBe(1);
  });

  it('cash drift is recorded but never healed', async () => {
    const h = makeDeps({ autoHealEnabled: true, priorCash: 800 });   // broker total 1000 vs prior 800
    await new Reconciliation(h.deps).run(WINDOW);
    expect(h.findingsWritten.some((f) => f.driftType === 'cash_drift')).toBe(true);
    expect(h.healCalls).toHaveLength(0);   // cash never auto-heals
  });

  it('clean book writes only clean rows and never heals', async () => {
    const h = makeDeps({ autoHealEnabled: true });   // sys == broker == 10
    const summary = await new Reconciliation(h.deps).run(WINDOW);
    expect(summary.healed).toBe(0);
    expect(h.findingsWritten.every((f) => f.isClean || f.driftType === null)).toBe(true);
  });

  it('NAV snapshot uses broker total (no position double-count); cash records free', async () => {
    // CASH = free 500 / total 1000 — total already includes positions; valuePositionsGbp → 110.
    const h = makeDeps();
    await new Reconciliation(h.deps).run(WINDOW);
    const n = h.lastNav();
    expect(n).not.toBeNull();
    expect(n!.nav).toBe(1000);            // broker total — positions already included
    expect(n!.nav).not.toBe(1110);        // regression: NOT total + positionsValue (old double-count)
    expect(n!.cash).toBe(500);            // FREE cash, so free + positions reconciles to nav in the portal
    expect(n!.positionsValue).toBe(110);
  });
});
