import type { User } from './User.ts';

export interface IUserRepository {
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  create(params: { id: string; email: string; passwordHash: string; role: 'admin' | 'user' }): Promise<User>;
}
