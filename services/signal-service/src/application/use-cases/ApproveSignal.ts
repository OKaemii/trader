import type { ISignalRepository } from '../../domain/interfaces/ISignalRepository.ts';
import { generateInternalToken } from '@trader/shared-auth';

const TRADING_SERVICE = process.env.TRADING_SERVICE_URL ?? 'http://trading-service:3005';

export class ApproveSignalUseCase {
  constructor(private readonly signalRepo: ISignalRepository) {}

  async execute(id: string): Promise<void> {
    await this.signalRepo.approve(id);
    // Fire-and-forget: trading-service's order placement makes real T212 calls (cash,
    // positions, place order) which can take seconds under rate limits. Awaiting the
    // round-trip would push the portal's approve POST past Bun.serve's idle timeout
    // (raised to 60s as defence-in-depth, but T212 can still stall longer). The signal is
    // already durably `approved` in Mongo; the order placement updates lifecycle via the
    // /internal/trading/signals/:id/* callbacks asynchronously. If trading-service fails,
    // the signal sits at `approved` and can be retried via POST /api/admin/trading/execute.
    // setTimeout fully detaches from the request frame. A bare `void promise.catch(...)`
    // still kept the response pending in Bun's Hono runtime — the handler returned but the
    // outgoing socket waited on the dangling fetch. Pushing onto the macrotask queue makes
    // the auto-execute strictly out-of-band from the HTTP response.
    setTimeout(() => {
      this.notifyTradingService(id).catch((e) => {
        console.warn(`[ApproveSignal] auto-execute notify failed for ${id}:`, e);
      });
    }, 0);
  }

  private async notifyTradingService(signalId: string): Promise<void> {
    const signal = await this.signalRepo.findById(signalId);
    if (!signal || signal.action === 'HOLD') return;

    const res = await fetch(`${TRADING_SERVICE}/internal/signals/trading/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': generateInternalToken('signal-service'),
      },
      body: JSON.stringify({
        signalId:     signal.id,
        ticker:       signal.ticker,
        action:       signal.action,
        targetWeight: signal.targetWeight,
        confidence:   signal.confidence,
      }),
    });
    if (!res.ok) {
      console.warn(`[ApproveSignal] trading-service returned ${res.status} for ${signalId}`);
    }
  }
}
