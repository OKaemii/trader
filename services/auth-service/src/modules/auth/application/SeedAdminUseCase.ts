import type { IUserRepository } from '../domain/IUserRepository.ts';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';

export class SeedAdminUseCase {
  constructor(private readonly users: IUserRepository) {}

  async execute(email: string, password: string): Promise<{ created: boolean; id?: string }> {
    const existing = await this.users.findByEmail(email);
    if (existing) return { created: false, id: existing.id };
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await this.users.create({ id: randomUUID(), email, passwordHash, role: 'admin' });
    return { created: true, id: user.id };
  }
}
