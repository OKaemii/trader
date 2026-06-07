'use client'
// Contextual "ⓘ Explain" toggletip for the learning layer (Task 5 of the portal-IA
// redesign — agent-docs/plans/portal-ia-redesign.md; deepened in Task 32 of
// agent-docs/plans/research-trading-os.md §F).
//
// A TOGGLETIP, not a hover tooltip: it opens on click/Enter (a real <button>), stays put
// for reading, and closes on click-outside/Escape. Rich content (title + summary + the
// reader's own value mapped to an interpretation band) is why it is a Popover, not the
// terse hover Tooltip primitive. PopoverContent carries role="status" so a screen reader
// announces the explanation when it opens.
//
// PROGRESSIVE DISCLOSURE (Task 32). The toggletip is LAYERED: the registry can carry up to
// three depths — plain summary (0) → key factors (1) → full detail (2) — and the reader
// steps through them under their own control via a "More detail"/"Less detail" button. The
// depth is local UI state, so it never gates anything (the safety-controls rule is about
// data/controls, not explanatory copy — showing more help is always safe). A metric only
// offers the deeper rungs it actually populates (maxDepth from the pure registry), so a
// summary-only metric shows no toggle at all and the original one-layer behaviour is intact.
//
// Built on components/ui/Popover (which self-portals — do NOT wrap it in a Portal here)
// and the pure METRICS/interpret registry. Renders nothing for an unknown id, so a
// mistyped metric degrades silently rather than throwing in a page.
import { ChevronDown, ChevronUp, Info } from 'lucide-react'
import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/Popover'
import { type Band, interpret, maxDepth, METRICS } from '@/app/lib/learning-content'

// Band tone → dark-theme text colour, matching the ui/* emerald/amber/red palette.
const TONE_CLASS: Record<Band['tone'], string> = {
  bad: 'text-red-400',
  weak: 'text-amber-400',
  good: 'text-emerald-300',
  strong: 'text-emerald-400',
}

export function Explain({ id, value }: { id: string; value?: number }) {
  const metric = METRICS[id]
  // The deepest rung this metric supports (0..2). Computed before the early-return guard so
  // hooks below run unconditionally regardless of which metric is shown (Rules of Hooks).
  const deepest = maxDepth(id)
  // The reader's current depth (0 = plain summary). Reset to 0 whenever the popover closes
  // so reopening always starts at the least-overwhelming layer — the desired default — even
  // though the component itself stays mounted across open/close.
  const [depth, setDepth] = useState(0)

  if (!metric) return null

  const band = value != null ? interpret(id, value) : null
  const shown = value != null ? (metric.fmt ? metric.fmt(value) : String(value)) : null

  // Clamp in render (not just on click) so a metric with fewer layers than a stale depth
  // value never indexes past its content.
  const current = Math.min(depth, deepest)

  return (
    <Popover onOpenChange={(open) => !open && setDepth(0)}>
      <PopoverTrigger
        aria-label={`Explain ${metric.title}`}
        className="inline-flex items-center text-gray-500 transition-colors hover:text-gray-300 focus:outline-none focus-visible:text-gray-300"
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent role="status">
        <div className="font-semibold text-gray-100">{metric.title}</div>

        {/* Depth 0 — the plain-English summary is always present. */}
        <p className="mt-1 text-gray-400">{metric.summary}</p>

        {/* Depth 1 — "key factors": the drivers that move the number. */}
        {current >= 1 && metric.factors && metric.factors.length > 0 && (
          <div className="mt-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Key factors</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-gray-300">
              {metric.factors.map((factor) => (
                <li key={factor}>{factor}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Depth 2 — "full detail": the precise definition + how to read it + the caveat. */}
        {current >= 2 && metric.detail && (
          <div className="mt-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Full detail</div>
            <p className="mt-1 text-gray-300">{metric.detail}</p>
          </div>
        )}

        {band && shown != null && (
          <p className="mt-2 text-gray-300">
            Your value: <span className="font-mono">{shown}</span> —{' '}
            <span className={TONE_CLASS[band.tone]}>{band.label}</span>
          </p>
        )}

        {/* Depth controls — only when the metric has a deeper rung than the one shown, or
            a shallower one to step back to. A real <button> pair keeps it keyboard-operable
            and inside the popover, so Escape still closes the whole toggletip. */}
        {deepest > 0 && (
          <div className="mt-2 flex items-center gap-3 border-t border-gray-800 pt-2 text-xs">
            {current < deepest && (
              <button
                type="button"
                onClick={() => setDepth((d) => Math.min(d + 1, deepest))}
                className="inline-flex items-center gap-1 text-gray-400 transition-colors hover:text-gray-200 focus:outline-none focus-visible:text-gray-200"
              >
                <ChevronDown className="h-3 w-3" aria-hidden="true" />
                More detail
              </button>
            )}
            {current > 0 && (
              <button
                type="button"
                onClick={() => setDepth((d) => Math.max(d - 1, 0))}
                className="inline-flex items-center gap-1 text-gray-400 transition-colors hover:text-gray-200 focus:outline-none focus-visible:text-gray-200"
              >
                <ChevronUp className="h-3 w-3" aria-hidden="true" />
                Less detail
              </button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
