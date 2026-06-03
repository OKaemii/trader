import type { Logger } from '@trader/core';
import type { RedisClientType } from 'redis';
import { subscribe } from '@trader/shared-redis';
import { ALERTS_TOPIC, type Alert, type AlertTier } from '@trader/shared-types';
import type { EmailSender } from '../infrastructure/email.ts';
import type { WebhookSender } from '../infrastructure/webhook.ts';

// Tier → channel routing. The webhook is the loud "page me now" channel reserved for `critical`;
// email covers `warning`+`critical`; `info` is log-only (audit/digest, never pages anyone). Each
// channel is independent + best-effort — one failing never blocks the other or crashes the loop.
const TIER_CHANNELS: Record<AlertTier, { webhook: boolean; email: boolean }> = {
  critical: { webhook: true, email: true },
  warning: { webhook: false, email: true },
  info: { webhook: false, email: false },
};

export interface AlertConsumerDeps {
  redis: RedisClientType;
  email: EmailSender | null;
  webhook: WebhookSender | null;
  alertEmailTo?: string | undefined;
  logger: Logger;
}

// Subscribes to the `alerts` pub/sub topic and fans each alert to the channels its tier maps to.
// Pub/sub (not a stream) is intentional: the durable record lives elsewhere — this is delivery only.
export class AlertConsumer {
  constructor(private readonly deps: AlertConsumerDeps) {}

  /** Subscribe; returns an unsubscribe fn for graceful shutdown. */
  async start(): Promise<() => void> {
    this.deps.logger.info(
      { webhook: !!this.deps.webhook, email: !!this.deps.email },
      'alert consumer subscribing',
    );
    return subscribe(this.deps.redis, ALERTS_TOPIC, (raw) => this.handle(raw));
  }

  private async handle(raw: unknown): Promise<void> {
    const alert = raw as Alert;
    if (!alert || typeof alert.tier !== 'string' || typeof alert.title !== 'string') {
      this.deps.logger.warn({ raw }, 'alert: malformed payload, ignoring');
      return;
    }
    const route = TIER_CHANNELS[alert.tier] ?? TIER_CHANNELS.info;
    const meta = { kind: alert.kind, source: alert.source, tier: alert.tier, detail: alert.meta };
    const line = `ALERT ${alert.title}`;
    if (alert.tier === 'critical') this.deps.logger.error(meta, line);
    else if (alert.tier === 'warning') this.deps.logger.warn(meta, line);
    else this.deps.logger.info(meta, line);

    await Promise.allSettled([
      (async () => {
        if (!route.webhook || !this.deps.webhook) return;
        try { await this.deps.webhook.send(alert); }
        catch (err) { this.deps.logger.warn({ err, kind: alert.kind }, 'alert webhook failed'); }
      })(),
      (async () => {
        if (!route.email || !this.deps.email) return;
        try { await this.deps.email.sendRaw(this.subject(alert), this.html(alert), this.deps.alertEmailTo); }
        catch (err) { this.deps.logger.warn({ err, kind: alert.kind }, 'alert email failed'); }
      })(),
    ]);
  }

  private subject(a: Alert): string {
    const icon = a.tier === 'critical' ? '🚨' : '⚠️';
    return `${icon} [${a.tier.toUpperCase()}] ${a.title}`;
  }

  private html(a: Alert): string {
    const metaRow = a.meta
      ? `<tr><td><b>Detail</b></td><td><pre>${JSON.stringify(a.meta, null, 2)}</pre></td></tr>`
      : '';
    return `<h2>${a.title}</h2><p>${a.detail}</p>
      <table border="1" cellpadding="6" style="border-collapse:collapse">
        <tr><td><b>Tier</b></td><td>${a.tier}</td></tr>
        <tr><td><b>Kind</b></td><td>${a.kind}</td></tr>
        <tr><td><b>Source</b></td><td>${a.source}</td></tr>
        <tr><td><b>Time</b></td><td>${new Date(a.ts).toISOString()}</td></tr>
        ${metaRow}
      </table>`;
  }
}
