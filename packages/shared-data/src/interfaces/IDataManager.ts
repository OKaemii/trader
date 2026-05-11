export interface FindOptions {
  limit?: number;
  filter?: Record<string, unknown>;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}

export interface IDataManager<T> {
  insert(entity: T): Promise<void>;
  insertMany(entities: T[]): Promise<void>;
  findById(id: string): Promise<T | null>;
  findMany(options?: FindOptions): Promise<T[]>;
  update(id: string, changes: Record<string, unknown>): Promise<void>;
  delete(id: string): Promise<void>;
  count(filter?: Record<string, unknown>): Promise<number>;
}
