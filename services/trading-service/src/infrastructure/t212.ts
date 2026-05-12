function t212Base(): string {
  return process.env.TRADING_MODE === 'live'
    ? 'https://live.trading212.com/api/v0'
    : 'https://demo.trading212.com/api/v0';
}

export class Trading212Client {
  private headers: Record<string, string>;

  constructor(apiKey: string, apiKeyId: string) {
    const auth = 'Basic ' + Buffer.from(`${apiKeyId}:${apiKey}`).toString('base64');
    this.headers = { Authorization: auth, 'Content-Type': 'application/json' };
  }

  async getPortfolio(): Promise<unknown> {
    const res = await fetch(`${t212Base()}/portfolio`, { headers: this.headers });
    if (!res.ok) throw new Error(`T212 portfolio: ${res.status}`);
    return res.json();
  }

  async getCash(): Promise<{ free: number; total: number }> {
    const res = await fetch(`${t212Base()}/equity/account/cash`, { headers: this.headers });
    if (!res.ok) throw new Error(`T212 cash: ${res.status}`);
    return res.json();
  }

  async getPositions(): Promise<unknown[]> {
    const res = await fetch(`${t212Base()}/equity/portfolio`, { headers: this.headers });
    if (!res.ok) throw new Error(`T212 positions: ${res.status}`);
    return res.json();
  }

  async placeMarketOrder(ticker: string, quantity: number): Promise<{ orderId: string }> {
    const body = JSON.stringify({ ticker, quantity, timeValidity: 'DAY' });
    const res  = await fetch(`${t212Base()}/equity/orders/market`, {
      method: 'POST', headers: this.headers, body,
    });
    if (!res.ok) throw new Error(`T212 market order: ${res.status} ${await res.text()}`);
    const data = await res.json() as any;
    return { orderId: String(data.id ?? data.orderId ?? 'unknown') };
  }

  async placeLimitOrder(ticker: string, quantity: number, limitPrice: number): Promise<{ orderId: string }> {
    const body = JSON.stringify({ ticker, quantity, limitPrice, timeValidity: 'DAY' });
    const res  = await fetch(`${t212Base()}/equity/orders/limit`, {
      method: 'POST', headers: this.headers, body,
    });
    if (!res.ok) throw new Error(`T212 limit order: ${res.status} ${await res.text()}`);
    const data = await res.json() as any;
    return { orderId: String(data.id ?? data.orderId ?? 'unknown') };
  }
}
