import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Logger } from '@trader/core';
import type { RedisClientType } from 'redis';
import type { Alert } from '@trader/shared-types';
import { AlertConsumer } from '../modules/notifications/application/AlertConsumer.ts';
import { WebhookSender } from '../modules/notifications/infrastructure/webhook.ts';
import type { EmailSender } from '../modules/notifications/infrastructure/email.ts';

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  trace: () => {}, fatal: () => {}, child: () => noopLogger, level: 'info',
} as unknown as Logger;

const alert = (tier: Alert['tier']): Alert => ({ tier, kind: 'k', title: 't', detail: 'd', source: 's', ts: 1 });

// AlertConsumer.handle is private; this is the unit under test, so reach it via a typed cast.
type Handleable = { handle(raw: unknown): Promise<void> };

function mkConsumer(opts: { withEmail?: boolean; withWebhook?: boolean } = { withEmail: true, withWebhook: true }) {
  const emailCalls: Array<{ subject: string; to?: string }> = [];
  const webhookCalls: Alert[] = [];
  const email = opts.withEmail
    ? ({ sendRaw: async (subject: string, _html: string, to?: string) => { emailCalls.push({ subject, to }); } } as unknown as EmailSender)
    : null;
  const webhook = opts.withWebhook
    ? ({ send: async (a: Alert) => { webhookCalls.push(a); } } as unknown as WebhookSender)
    : null;
  const c = new AlertConsumer({
    redis: {} as unknown as RedisClientType,
    email, webhook, alertEmailTo: 'ops@example.com', logger: noopLogger,
  });
  return { c: c as unknown as Handleable, emailCalls, webhookCalls };
}

describe('AlertConsumer routing', () => {
  it('critical → webhook + email (to the alert recipient)', async () => {
    const { c, emailCalls, webhookCalls } = mkConsumer();
    await c.handle(alert('critical'));
    expect(webhookCalls).toHaveLength(1);
    expect(emailCalls).toHaveLength(1);
    expect(emailCalls[0]!.to).toBe('ops@example.com');
  });

  it('warning → email only (no webhook)', async () => {
    const { c, emailCalls, webhookCalls } = mkConsumer();
    await c.handle(alert('warning'));
    expect(webhookCalls).toHaveLength(0);
    expect(emailCalls).toHaveLength(1);
  });

  it('info → log only (no webhook, no email)', async () => {
    const { c, emailCalls, webhookCalls } = mkConsumer();
    await c.handle(alert('info'));
    expect(webhookCalls).toHaveLength(0);
    expect(emailCalls).toHaveLength(0);
  });

  it('ignores a malformed payload', async () => {
    const { c, emailCalls, webhookCalls } = mkConsumer();
    await c.handle({ nope: true });
    expect(webhookCalls).toHaveLength(0);
    expect(emailCalls).toHaveLength(0);
  });

  it('does not throw when channels are unconfigured (null senders)', async () => {
    const { c } = mkConsumer({ withEmail: false, withWebhook: false });
    await expect(c.handle(alert('critical'))).resolves.toBeUndefined();
  });
});

describe('WebhookSender payload', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts text + content + structured fields, throws on non-2xx', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await new WebhookSender('https://hook.example/x', noopLogger).send(alert('critical'));
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.text).toContain('CRITICAL');
    expect(body.content).toContain('CRITICAL');
    expect(body.tier).toBe('critical');
    expect(body.kind).toBe('k');

    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 500 })));
    await expect(new WebhookSender('https://hook.example/x', noopLogger).send(alert('critical'))).rejects.toThrow('500');
  });
});
