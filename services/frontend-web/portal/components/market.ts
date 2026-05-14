// Shared market-classification helpers. T212 returns the canonical instrument id with a
// suffix that encodes the exchange — `_US_EQ` for NYSE/NASDAQ primary, `l_EQ` for London.
// Used by visualisations (badges, card accents, market clock) to colour-code per region.

export type Market = 'US' | 'LSE' | 'OTHER'

export function marketOf(ticker: string | undefined): Market {
  if (!ticker) return 'OTHER'
  if (/_US_EQ$/.test(ticker)) return 'US'
  if (/l_EQ$/.test(ticker)) return 'LSE'
  return 'OTHER'
}

// Tailwind classes per market. Keep palette deliberately quiet — markets should
// distinguish at a glance without competing with action pills (BUY/SELL emerald/red).
export const MARKET_STYLES: Record<Market, { bg: string; text: string; border: string; label: string }> = {
  US:    { bg: 'bg-blue-900/50',   text: 'text-blue-300',   border: 'border-l-blue-500',   label: 'US' },
  LSE:   { bg: 'bg-indigo-900/50', text: 'text-indigo-300', border: 'border-l-indigo-500', label: 'LSE' },
  OTHER: { bg: 'bg-gray-800',      text: 'text-gray-400',   border: 'border-l-gray-700',   label: '—' },
}
