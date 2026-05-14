import type { TradeSignal, SignalFailureReason } from '../entities/TradeSignal.ts';

export interface ISignalRepository {
  save(signal: TradeSignal): Promise<void>;
  findById(id: string): Promise<TradeSignal | null>;
  findRecent(limit: number): Promise<TradeSignal[]>;
  approve(id: string): Promise<void>;
  markExecuted(id: string, at: number, executedQuantity?: number): Promise<void>;
  markClosed(id: string, at: number, exitPrice: number): Promise<void>;
  // FIFO round-trip closure: returns executed BUY signals for a ticker, oldest-first by
  // executedAt, with non-zero executedQuantity. SELL fills walk this list to attribute shares.
  findOpenBuysByTicker(ticker: string): Promise<TradeSignal[]>;
  // Decrements an open BUY signal's executedQuantity (used when a SELL only partially
  // consumes the next BUY in FIFO order). Caller is responsible for not driving below zero.
  decrementExecutedQuantity(id: string, by: number): Promise<void>;
  // Used by the auto-approve cash pro-rate path. When free cash < total BUY notional, the
  // gate scales every BUY's targetWeight by the same factor before approving so the
  // optimiser's ratios and sector cap survive. The recorded targetWeight reflects what
  // trading-service will size the order against.
  setTargetWeight(id: string, targetWeight: number): Promise<void>;

  // Queue / dispatcher lifecycle. Together these implement the durable queue: the
  // signal doc is the queue, and atomic findOneAndUpdate gives multi-pod safety.

  // approved → queued. Called when ApproveSignal accepts a signal for dispatch.
  markQueued(id: string): Promise<void>;
  // queued → executing. Atomic FIFO claim sorted by timestamp. Increments attempts and
  // sets lastAttemptAt. Returns null if no queued signals exist (so the dispatcher loop
  // can sleep instead of busy-waiting). Concurrency-safe across pods.
  claimNextQueued(): Promise<TradeSignal | null>;
  // executing → queued. Used on retryable failures (T212 429, transient network errors)
  // so the dispatcher loop picks the row back up on the next tick. Does NOT increment
  // attempts — that already happened on claim.
  requeue(id: string): Promise<void>;
  // any non-terminal state → failed (terminal). Records the reason and detail so the
  // portal can show why. Consumers must filter to lifecycle ∈ {executed, closed} so
  // failed signals are treated as if they never happened.
  markFailed(id: string, reason: SignalFailureReason, detail?: string): Promise<void>;
  // failed → queued, attempts reset to 0. Admin-triggered retry from the portal.
  retry(id: string): Promise<void>;
  // Boot-time crash recovery: executing rows older than thresholdMs likely belong to
  // a pod that died mid-flight. Revert them to queued so the new pod picks them up.
  // FillsPoller is authoritative for whether the order actually reached T212.
  sweepStaleExecuting(thresholdMs: number): Promise<number>;
  // List signals whose lifecycle is in `states`, oldest-first by timestamp. Used by the
  // portal "In transit" / "Failed" filter views.
  findByLifecycle(states: TradeSignal['lifecycle'][], limit: number): Promise<TradeSignal[]>;
}
