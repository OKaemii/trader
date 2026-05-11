import { describe, expect, it, beforeEach } from 'bun:test';
import { generateInternalToken, validateInternalToken } from '../internal-token.ts';

beforeEach(() => {
  process.env.INTERNAL_SECRET = 'test-internal-secret';
});

describe('generateInternalToken + validateInternalToken', () => {
  it('validates a freshly generated token', () => {
    const token = generateInternalToken('api-gateway');
    expect(() => validateInternalToken(token, 'api-gateway')).not.toThrow();
  });

  it('rejects a token for a different caller service', () => {
    const token = generateInternalToken('api-gateway');
    expect(() => validateInternalToken(token, 'other-service')).toThrow();
  });

  it('rejects a malformed token', () => {
    expect(() => validateInternalToken('notvalid', 'api-gateway')).toThrow();
  });

  it('rejects a token with wrong secret', () => {
    const token = generateInternalToken('api-gateway');
    process.env.INTERNAL_SECRET = 'different-secret';
    expect(() => validateInternalToken(token, 'api-gateway')).toThrow();
  });
});
