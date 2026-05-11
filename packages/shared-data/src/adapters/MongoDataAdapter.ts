import type { Collection, Document, OptionalUnlessRequiredId, WithId } from 'mongodb';
import type { IDataManager, FindOptions } from '../interfaces/IDataManager.ts';

export class MongoDataAdapter<T, TDoc extends Document = Document> implements IDataManager<T> {
  constructor(
    private readonly collection: Collection<TDoc>,
    private readonly toDoc: (entity: T) => OptionalUnlessRequiredId<TDoc>,
    private readonly fromDoc: (doc: WithId<TDoc>) => T,
  ) {}

  async insert(entity: T): Promise<void> {
    await this.collection.insertOne(this.toDoc(entity));
  }

  async insertMany(entities: T[]): Promise<void> {
    if (!entities.length) return;
    await this.collection.insertMany(entities.map(this.toDoc) as OptionalUnlessRequiredId<TDoc>[]);
  }

  async findById(id: string): Promise<T | null> {
    const doc = await this.collection.findOne({ _id: id } as any);
    return doc ? this.fromDoc(doc) : null;
  }

  async findMany({ limit = 50, filter = {}, sortBy, sortDir = 'desc' }: FindOptions = {}): Promise<T[]> {
    let cursor = this.collection.find(filter as any).limit(limit);
    if (sortBy) cursor = cursor.sort({ [sortBy]: sortDir === 'asc' ? 1 : -1 });
    return (await cursor.toArray()).map(this.fromDoc);
  }

  async update(id: string, changes: Record<string, unknown>): Promise<void> {
    await this.collection.updateOne({ _id: id } as any, { $set: changes });
  }

  async delete(id: string): Promise<void> {
    await this.collection.deleteOne({ _id: id } as any);
  }

  async count(filter: Record<string, unknown> = {}): Promise<number> {
    return this.collection.countDocuments(filter as any);
  }
}
