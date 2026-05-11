export interface ICacheInvalidationBus {
  publish(namespace: string, key: string): Promise<void>;
  subscribe(namespace: string, handler: (key: string) => Promise<void>): Promise<void>;
  unsubscribe(): Promise<void>;
}
