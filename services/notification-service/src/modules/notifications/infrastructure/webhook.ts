import type { Logger } from '@trader/core';
import type { Alert } from '@trader/shared-types';

// Posts an alert to a generic incoming webhook (Slack / Discord / custom). The body carries both
// `text` (Slack) and `content` (Discord) summary fields alongside the full structured Alert, so a
// generic receiver gets everything while the two common chat platforms render the summary natively.
// Best-effort: a non-2xx throws → the AlertConsumer logs and moves on (never crashes the loop).
export class WebhookSender {
  constructor(private readonly url: string, private readonly logger: Logger) {}

  async send(alert: Alert): Promise<void> {
    const icon = alert.tier === 'critical' ? '🚨' : alert.tier === 'warning' ? '⚠️' : 'ℹ️';
    const text = `${icon} [${alert.tier.toUpperCase()}] ${alert.title}\n${alert.detail}\n— ${alert.source} @ ${new Date(alert.ts).toISOString()}`;
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, content: text, ...alert }),
    });
    if (!res.ok) throw new Error(`webhook POST failed (${res.status})`);
    this.logger.info({ kind: alert.kind, tier: alert.tier }, 'alert webhook delivered');
  }
}
