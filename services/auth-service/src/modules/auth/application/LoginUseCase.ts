import type { IUserRepository } from '../domain/IUserRepository.ts';
import type { IRefreshTokenStore } from '../domain/IRefreshTokenStore.ts';
import { signAccessToken, signRefreshToken } from '@trader/shared-auth/jwt';
import bcrypt from 'bcryptjs';

export class LoginUseCase {
  constructor(
    private readonly users: IUserRepository,
    private readonly tokenStore: IRefreshTokenStore,
  ) {}

  async execute(email: string, password: string): Promise<{ accessToken: string; refreshToken: string }> {
    const user = await this.users.findByEmail(email);
    if (!user) throw Object.assign(new Error('Invalid credentials'), { code: 'UNAUTHORIZED' });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw Object.assign(new Error('Invalid credentials'), { code: 'UNAUTHORIZED' });

    const accessToken  = await signAccessToken({ sub: user.id, role: user.role });
    const refreshToken = await signRefreshToken(user.id);

    await this.tokenStore.save(user.id, refreshToken, 7 * 86400);

    return { accessToken, refreshToken };
  }
}
