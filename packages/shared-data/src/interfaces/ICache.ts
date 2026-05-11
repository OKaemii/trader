export interface ICache<T> {
  get(key: string): Promise<T | null>;
  set(key: string, value: T): Promise<void>;
  invalidate(key: string): Promise<void>;
  invalidatePattern(pattern: string): Promise<void>;
  getOrLoad(key: string, loader: () => Promise<T | null>): Promise<T | null>;
}
