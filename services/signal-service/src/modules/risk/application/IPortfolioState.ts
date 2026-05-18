export interface IPortfolioState {
  currentWeights(): Promise<Record<string, number>>;
  currentDrawdown(): Promise<number>;  // 0–1; fraction below high-water mark
}
