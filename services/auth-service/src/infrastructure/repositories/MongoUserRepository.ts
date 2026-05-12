import type { IUserRepository } from '../../domain/interfaces/IUserRepository.ts';
import { User } from '../../domain/entities/User.ts';
import { getMongoDb, COLLECTIONS } from '@trader/shared-mongo';

export class MongoUserRepository implements IUserRepository {
  async findByEmail(email: string): Promise<User | null> {
    const db = await getMongoDb();
    const doc = await db.collection(COLLECTIONS.USERS).findOne({ email });
    return doc ? this.toEntity(doc) : null;
  }

  async findById(id: string): Promise<User | null> {
    const db = await getMongoDb();
    const doc = await db.collection(COLLECTIONS.USERS).findOne({ _id: id });
    return doc ? this.toEntity(doc) : null;
  }

  async create(params: { id: string; email: string; passwordHash: string; role: 'admin' | 'user' }): Promise<User> {
    const db = await getMongoDb();
    const createdAt = new Date();
    await db.collection(COLLECTIONS.USERS).insertOne({ _id: params.id, ...params, createdAt });
    return new User(params.id, params.email, params.passwordHash, params.role, createdAt);
  }

  private toEntity(doc: Record<string, unknown>): User {
    return new User(
      String(doc._id),
      doc.email as string,
      doc.passwordHash as string,
      (doc.role as 'admin' | 'user') ?? 'user',
      doc.createdAt instanceof Date ? doc.createdAt : new Date(doc.createdAt as string),
    );
  }
}
