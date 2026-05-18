import type { ISignalRepository } from '../../signals/domain/ISignalRepository.ts';

// ApproveSignal flips lifecycle pending → approved → queued.
//
// The queued state is the durable signal that trading-service's order-dispatcher acts on:
// it polls Mongo for {lifecycle:'queued'}, atomically claims the next signal (FIFO by
// timestamp), and handles T212 placement / retries / drift checks / failure transitions.
//
// We deliberately do NOT call trading-service synchronously here. The previous design
// (setTimeout fire-and-forget POST to /internal/signals/trading/execute) was fragile
// under T212 rate limits — a 429 storm would leave signals stuck at `approved` with no
// retry path. The dispatcher loop owns retry semantics now; this use-case only has to
// durably mark the signal as ready for dispatch.
export class ApproveSignalUseCase {
  constructor(private readonly signalRepo: ISignalRepository) {}

  async execute(id: string): Promise<void> {
    await this.signalRepo.approve(id);
    // HOLD actions are degenerate (no order to place) but the dispatcher filters them out
    // on claim, so we still queue uniformly. Keeps the lifecycle graph predictable.
    const signal = await this.signalRepo.findById(id);
    if (!signal || signal.action === 'HOLD') return;
    await this.signalRepo.markQueued(id);
  }
}
