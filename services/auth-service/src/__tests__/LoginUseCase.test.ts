import { describe, it, expect, beforeEach } from 'bun:test';
import { LoginUseCase } from '../application/use-cases/LoginUseCase.ts';
import { User } from '../domain/entities/User.ts';
import type { IUserRepository } from '../domain/interfaces/IUserRepository.ts';
import type { IRefreshTokenStore } from '../domain/interfaces/IRefreshTokenStore.ts';
import { verifyAccessToken } from '@trader/shared-auth/jwt';
import bcrypt from 'bcryptjs';

process.env.JWT_SECRET = 'test-secret-for-unit-tests';

class MockUserRepository implements IUserRepository {
  private store = new Map<string, User>();

  async findByEmail(email: string) {
    for (const u of this.store.values()) if (u.email === email) return u;
    return null;
  }

  async findById(id: string) { return this.store.get(id) ?? null; }

  async create(p: { id: string; email: string; passwordHash: string; role: 'admin' | 'user' }) {
    const u = new User(p.id, p.email, p.passwordHash, p.role, new Date());
    this.store.set(p.id, u);
    return u;
  }

  async seed(id: string, email: string, plainPassword: string, role: 'admin' | 'user' = 'user') {
    const passwordHash = await bcrypt.hash(plainPassword, 4);
    const u = new User(id, email, passwordHash, role, new Date());
    this.store.set(id, u);
    return u;
  }
}

class MockTokenStore implements IRefreshTokenStore {
  saved: Array<{ userId: string; token: string; ttl: number }> = [];
  async save(userId: string, token: string, ttlSeconds: number) {
    this.saved.push({ userId, token, ttl: ttlSeconds });
  }
}

describe('LoginUseCase — login → JWT flow', () => {
  let repo: MockUserRepository;
  let tokenStore: MockTokenStore;
  let useCase: LoginUseCase;

  beforeEach(() => {
    repo = new MockUserRepository();
    tokenStore = new MockTokenStore();
    useCase = new LoginUseCase(repo as unknown as IUserRepository, tokenStore);
  });

  it('returns accessToken + refreshToken for valid credentials', async () => {
    await repo.seed('u1', 'alice@test.com', 'password123');
    const { accessToken, refreshToken } = await useCase.execute('alice@test.com', 'password123');
    expect(typeof accessToken).toBe('string');
    expect(typeof refreshToken).toBe('string');
  });

  it('accessToken payload carries correct sub and role', async () => {
    await repo.seed('u2', 'bob@test.com', 'pass', 'admin');
    const { accessToken } = await useCase.execute('bob@test.com', 'pass');
    const payload = await verifyAccessToken(accessToken);
    expect(payload.sub).toBe('u2');
    expect(payload.role).toBe('admin');
  });

  it('stores refresh token in token store with 7-day TTL', async () => {
    await repo.seed('u3', 'carol@test.com', 'pass');
    const { refreshToken } = await useCase.execute('carol@test.com', 'pass');
    expect(tokenStore.saved).toHaveLength(1);
    expect(tokenStore.saved[0].userId).toBe('u3');
    expect(tokenStore.saved[0].token).toBe(refreshToken);
    expect(tokenStore.saved[0].ttl).toBe(7 * 86400);
  });

  it('throws UNAUTHORIZED for unknown email', async () => {
    await expect(useCase.execute('nobody@test.com', 'x')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('throws UNAUTHORIZED for wrong password', async () => {
    await repo.seed('u4', 'dave@test.com', 'correct');
    await expect(useCase.execute('dave@test.com', 'wrong')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
