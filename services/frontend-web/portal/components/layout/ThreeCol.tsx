import type { ReactNode } from 'react'

// Generic LHS · center · RHS workspace layout. The center column is the visual focus (widest);
// the left and right columns are subordinate rails. This is the reusable skeleton behind the
// Workspace hero + rail (Task 19) and is intended for reuse by the Research workspace and dense
// list views (T31 mounts a MarketNarrative panel into one of these slots; T38 reuses the layout).
//
// Design contract (so reuse stays predictable):
//   - `center` is the primary content and always renders. It dominates by column span, not by any
//     content-specific styling — the wrapper is layout-only and ships no card chrome of its own.
//   - `left` / `right` are optional rails. An absent rail collapses its track so the center widens
//     to fill the row — a one-rail page reads as focus + single rail with no empty gutter.
//   - Below the `xl` breakpoint the grid stacks to a single column in source order (center first by
//     default, so the focus paints first on mobile); pass `railsFirst` when a page wants its context
//     rail above the center on small screens.
//
// It is deliberately unopinionated about the column ratio so each surface can tune density: the
// default mirrors the spec's wide-center emphasis (2fr center, 1fr rails), overridable via
// `centerSpan` for surfaces that want a more even split.

export interface ThreeColProps {
  /** Primary, focus content. Always rendered; dominates by span. */
  center: ReactNode
  /** Optional left rail. Collapses when absent. */
  left?: ReactNode
  /** Optional right rail. Collapses when absent. */
  right?: ReactNode
  /**
   * Center-column weight relative to each present rail (rails are 1fr each).
   * Default 2 → a wide center flanked by narrow rails. Clamped to ≥1.
   */
  centerSpan?: number
  /** On the stacked (single-column) layout, render the rails above the center. */
  railsFirst?: boolean
  className?: string
}

export function ThreeCol({
  center,
  left,
  right,
  centerSpan = 2,
  railsFirst = false,
  className = '',
}: ThreeColProps): ReactNode {
  const span = Math.max(1, centerSpan)
  // Build the wide-screen track list from only the present columns so an absent rail truly
  // collapses (no `0fr` ghost gutter). The center is always present.
  const tracks = [left ? '1fr' : null, `${span}fr`, right ? '1fr' : null].filter(Boolean).join(' ')

  const leftRail = left ? (
    <aside key="left" className="min-w-0 space-y-4">
      {left}
    </aside>
  ) : null
  const rightRail = right ? (
    <aside key="right" className="min-w-0 space-y-4">
      {right}
    </aside>
  ) : null
  const main = (
    <section key="center" className="min-w-0 space-y-4">
      {center}
    </section>
  )

  // Stacked order: by default center first (focus paints first on mobile); railsFirst flips it so a
  // page can lead the small-screen flow with its context rail.
  const stacked = railsFirst ? [leftRail, main, rightRail] : [main, leftRail, rightRail]

  // grid-cols-1 holds below xl (single-column stack); at xl the arbitrary `grid-template-columns`
  // utility reads the runtime track list via a CSS var (Tailwind can't express a dynamic ratio).
  return (
    <div
      data-testid="three-col"
      className={`grid grid-cols-1 gap-6 xl:[grid-template-columns:var(--three-col-tracks)] ${className}`.trim()}
      style={{ ['--three-col-tracks' as string]: tracks }}
    >
      {stacked}
    </div>
  )
}
