export interface IPortfolioState {
  currentWeights(): Promise<Record<string, number>>;
}
