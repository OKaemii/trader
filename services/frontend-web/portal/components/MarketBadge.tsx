import { MARKET_STYLES, marketOf, type Market } from './market'

interface Props {
  ticker?: string
  market?: Market
  className?: string
}

export function MarketBadge({ ticker, market, className = '' }: Props) {
  const m: Market = market ?? marketOf(ticker)
  const style = MARKET_STYLES[m]
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${style.bg} ${style.text} ${className}`}
      title={m === 'OTHER' ? 'Unknown market' : `${style.label} listing`}
    >
      {style.label}
    </span>
  )
}
