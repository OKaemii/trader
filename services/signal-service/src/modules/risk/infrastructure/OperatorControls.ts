import type { RedisClientType } from 'redis';

// Operator-set safety flags, distinct from the automatic NAV circuit breaker:
//   - trading:kill_switch — global halt. Stops new signal emission (GenerateSignals via
//     canTrade) AND the trading-service dispatcher's queue drain. The big red button.
//   - strategy:paused — pauses signal emission only; the dispatcher keeps draining in-flight
//     orders (a softer "stop generating, let the queue finish").
// Both are no-TTL Redis flags (survive restarts) — cleared explicitly by the operator. Mirrors
// the CircuitBreakerRedis pattern; kept separate so an operator halt is never confused with an
// auto NAV trip (and the reset paths stay independent).
const KILL_SWITCH_KEY = 'trading:kill_switch';
const PAUSED_KEY = 'strategy:paused';

export interface OperatorState { killSwitch: boolean; paused: boolean }

export class OperatorControls {
  constructor(private readonly redis: RedisClientType) {}

  async killSwitchEngaged(): Promise<boolean> { return (await this.redis.get(KILL_SWITCH_KEY)) === '1'; }
  async paused(): Promise<boolean> { return (await this.redis.get(PAUSED_KEY)) === '1'; }

  async state(): Promise<OperatorState> {
    const [k, p] = await Promise.all([this.killSwitchEngaged(), this.paused()]);
    return { killSwitch: k, paused: p };
  }

  async setKillSwitch(on: boolean): Promise<void> {
    if (on) await this.redis.set(KILL_SWITCH_KEY, '1');
    else await this.redis.del(KILL_SWITCH_KEY);
  }

  async setPaused(on: boolean): Promise<void> {
    if (on) await this.redis.set(PAUSED_KEY, '1');
    else await this.redis.del(PAUSED_KEY);
  }
}
