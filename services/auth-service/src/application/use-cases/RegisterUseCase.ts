import type { IUserRepository } from '../../domain/interfaces/IUserRepository.ts';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';

export class RegisterUseCase {
  constructor(private readonly users: IUserRepository) {}

  async execute(email: string, password: string): Promise<{ id: string }> {
    const existing = await this.users.findByEmail(email);
    if (existing) throw Object.assign(new Error('Email already registered'), { code: 'CONFLICT' });
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await this.users.create({ id: randomUUID(), email, passwordHash, role: 'user' });
    return { id: user.id };
  }
}
