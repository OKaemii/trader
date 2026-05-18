export interface IRefreshTokenStore {
  save(userId: string, token: string, ttlSeconds: number): Promise<void>;
}
