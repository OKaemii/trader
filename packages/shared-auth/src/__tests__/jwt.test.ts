import { describe, expect, it, beforeEach } from "vitest";
import { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken } from '../jwt.ts';

beforeEach(() => {
  process.env.JWT_SECRET = 'test-secret-for-unit-tests';
});

describe('signAccessToken + verifyAccessToken', () => {
  it('round-trips a valid access token', async () => {
    const token = await signAccessToken({ sub: 'user-1', role: 'user' });
    const payload = await verifyAccessToken(token);
    expect(payload.sub).toBe('user-1');
    expect(payload.role).toBe('user');
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signAccessToken({ sub: 'user-1', role: 'user' });
    process.env.JWT_SECRET = 'different-secret';
    await expect(verifyAccessToken(token)).rejects.toThrow();
  });

  it('rejects a tampered token', async () => {
    const token = await signAccessToken({ sub: 'user-1', role: 'user' });
    const tampered = token.slice(0, -5) + 'XXXXX';
    await expect(verifyAccessToken(tampered)).rejects.toThrow();
  });
});

describe('signRefreshToken + verifyRefreshToken', () => {
  it('round-trips a valid refresh token', async () => {
    const token = await signRefreshToken('user-1');
    const { sub } = await verifyRefreshToken(token);
    expect(sub).toBe('user-1');
  });

  it('rejects an access token passed to verifyRefreshToken', async () => {
    const accessToken = await signAccessToken({ sub: 'user-1', role: 'user' });
    await expect(verifyRefreshToken(accessToken)).rejects.toThrow();
  });
});
