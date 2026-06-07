import type { ReactNode } from 'react'

// Generic hero shell — the single most prominent block on a workspace page. It owns the focus
// chrome (elevated panel: subtle top-lit gradient, rounded-xl, ring) so the visual hierarchy
// (size · contrast · depth) lives in one place and every hero on the platform reads the same. The
// PortfolioOverviewHero (Task 19) is the first consumer; T31's MarketNarrative and T38's other
// dense surfaces reuse this same shell, so its props stay content-agnostic.
//
// Hierarchy contract:
//   - The hero is depth-elevated vs. the surrounding rail cards (gradient + ring + larger padding),
//     so it dominates by chrome as well as by the page placing it first/full-bleed. Rail cards use
//     the flatter `bg-gray-900 border-gray-800` treatment — do not give them this shell.
//   - `eyebrow` (kicker), `title`, and `aside` form the header row; `children` is the hero body
//     (the consumer's chart/figures). All header slots are optional so a minimal hero is just a body.
//   - It is layout/chrome only — no data fetching, no client state — so it composes inside server
//     components and gets SSR-seeded by whatever the consumer renders into `children`.

export interface HeroProps {
  /** Small uppercase kicker above the title (e.g. "Portfolio overview"). */
  eyebrow?: ReactNode
  /** The hero's headline value or label. */
  title?: ReactNode
  /** Top-right slot — a status chip, mode badge, or range control. */
  aside?: ReactNode
  /** The hero body — the focus content (chart + headline figures). */
  children?: ReactNode
  className?: string
}

export function Hero({ eyebrow, title, aside, children, className = '' }: HeroProps): ReactNode {
  const hasHeader = eyebrow != null || title != null || aside != null
  return (
    <section
      className={`rounded-xl border border-gray-700 bg-gradient-to-b from-gray-900 to-gray-950 p-6 shadow-lg ring-1 ring-white/5 ${className}`.trim()}
    >
      {hasHeader && (
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            {eyebrow != null && (
              <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{eyebrow}</div>
            )}
            {title != null && <div className="mt-1 min-w-0">{title}</div>}
          </div>
          {aside != null && <div className="shrink-0">{aside}</div>}
        </div>
      )}
      {children != null && <div className={hasHeader ? 'mt-5' : ''}>{children}</div>}
    </section>
  )
}
