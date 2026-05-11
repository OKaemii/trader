import { createHmac } from 'node:crypto';

const WINDOW_MS = 5 * 60 * 1000; // 5-minute replay window

function secret(): string {
  return process.env.INTERNAL_SECRET ?? 'dev-internal-secret-change-me';
}

/**
 * Generate a short-lived HMAC token for service-to-service calls.
 * Format: "<timestamp>.<hmac>"
 */
export function generateInternalToken(callerService: string): string {
  const ts = Date.now().toString();
  const hmac = createHmac('sha256', secret())
    .update(`${callerService}:${ts}`)
    .digest('hex');
  return `${ts}.${hmac}`;
}

/**
 * Validate an internal token. Throws if invalid or expired.
 */
export function validateInternalToken(token: string, callerService: string): void {
  const [ts, hmac] = token.split('.');
  if (!ts || !hmac) throw new Error('Malformed internal token');

  const age = Date.now() - Number(ts);
  if (age < 0 || age > WINDOW_MS) throw new Error('Internal token expired');

  const expected = createHmac('sha256', secret())
    .update(`${callerService}:${ts}`)
    .digest('hex');

  // Constant-time comparison to prevent timing attacks
  if (hmac.length !== expected.length) throw new Error('Invalid internal token');
  let diff = 0;
  for (let i = 0; i < hmac.length; i++) diff |= hmac.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) throw new Error('Invalid internal token');
}
