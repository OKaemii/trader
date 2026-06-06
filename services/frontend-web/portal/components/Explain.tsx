'use client'
// Contextual "ⓘ Explain" toggletip for the learning layer (Task 5 of the portal-IA
// redesign — agent-docs/plans/portal-ia-redesign.md).
//
// A TOGGLETIP, not a hover tooltip: it opens on click/Enter (a real <button>), stays put
// for reading, and closes on click-outside/Escape. Rich content (title + summary + the
// reader's own value mapped to an interpretation band) is why it is a Popover, not the
// terse hover Tooltip primitive. PopoverContent carries role="status" so a screen reader
// announces the explanation when it opens.
//
// Built on components/ui/Popover (which self-portals — do NOT wrap it in a Portal here)
// and the pure METRICS/interpret registry. Renders nothing for an unknown id, so a
// mistyped metric degrades silently rather than throwing in a page.
import { Info } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/Popover'
import { type Band, interpret, METRICS } from '@/app/lib/learning-content'

// Band tone → dark-theme text colour, matching the ui/* emerald/amber/red palette.
const TONE_CLASS: Record<Band['tone'], string> = {
  bad: 'text-red-400',
  weak: 'text-amber-400',
  good: 'text-emerald-300',
  strong: 'text-emerald-400',
}

export function Explain({ id, value }: { id: string; value?: number }) {
  const metric = METRICS[id]
  if (!metric) return null

  const band = value != null ? interpret(id, value) : null
  const shown = value != null ? (metric.fmt ? metric.fmt(value) : String(value)) : null

  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Explain ${metric.title}`}
        className="inline-flex items-center text-gray-500 transition-colors hover:text-gray-300 focus:outline-none focus-visible:text-gray-300"
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent role="status">
        <div className="font-semibold text-gray-100">{metric.title}</div>
        <p className="mt-1 text-gray-400">{metric.summary}</p>
        {band && shown != null && (
          <p className="mt-2 text-gray-300">
            Your value: <span className="font-mono">{shown}</span> —{' '}
            <span className={TONE_CLASS[band.tone]}>{band.label}</span>
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
