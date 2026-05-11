const BASE = 'https://live.trading212.com/api/v0';

export class Trading212Client {
  private headers: Record<string, string>;

  constructor(apiKey: string) {
    this.headers = { Authorization: apiKey, 'Content-Type': 'application/json' };
  }

  async getPortfolio(): Promise<unknown> {
    const res = await fetch(`${BASE}/portfolio`, { headers: this.headers });
    if (!res.ok) throw new Error(`T212 portfolio: ${res.status}`);
    return res.json();
  }

  async getCash(): Promise<{ free: number; total: number }> {
    const res = await fetch(`${BASE}/equity/account/cash`, { headers: this.headers });
    if (!res.ok) throw new Error(`T212 cash: ${res.status}`);
    return res.json();
  }

  async getPositions(): Promise<unknown[]> {
    const res = await fetch(`${BASE}/equity/portfolio`, { headers: this.headers });
    if (!res.ok) throw new Error(`T212 positions: ${res.status}`);
    return res.json();
  }

  // v2: automated order placement — disabled in v1 (TRADING_MODE=paper)
  // async placeMarketOrder(ticker: string, quantity: number): Promise<unknown> {
  //   const body = JSON.stringify({ ticker, quantity, timeValidity: 'DAY' });
  //   const res = await fetch(`${BASE}/equity/orders/market`, {
  //     method: 'POST', headers: this.headers, body,
  //   });
  //   if (!res.ok) throw new Error(`T212 order: ${res.status} ${await res.text()}`);
  //   return res.json();
  // }
}
