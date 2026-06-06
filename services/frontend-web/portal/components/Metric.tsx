// A labelled metric value with an inline "ⓘ Explain" affordance (Task 5 of the portal-IA
// redesign — agent-docs/plans/portal-ia-redesign.md). This is the consumer-facing shape
// the real metric displays adopt in card #15 (Performance KPIs, Positions R-multiple,
// Signals factor exposure, Research PBO/DSR).
//
// No 'use client' directive: this component has no hooks or handlers of its own. It
// composes the pure registry (for the shared formatter) with <Explain> (which is the
// client boundary). That keeps <Metric> usable from a server component OR a client one —
// Next marks the client boundary at <Explain>, not here.
//
//   <Metric label="Sharpe" value={1.42} id="sharpe" />
//
// Renders: "Sharpe  1.42  ⓘ", where the value is formatted by the metric's `fmt` (e.g.
// percent for drawdown/vol) and the toggletip opens the value + interpretation band.
import { Explain } from './Explain'
import { METRICS } from '@/app/lib/learning-content'
import { cn } from '@/components/ui/cn'

export function Metric({
  label,
  value,
  id,
  className,
}: {
  label: string
  value: number
  /** Metric registry id (e.g. 'sharpe'). Drives both the value formatting and <Explain>. */
  id: string
  className?: string
}) {
  const metric = METRICS[id]
  const shown = metric?.fmt ? metric.fmt(value) : String(value)

  return (
    <span className={cn('inline-flex items-baseline gap-1.5 text-sm', className)}>
      <span className="text-gray-400">{label}</span>
      <span className="font-mono text-gray-100">{shown}</span>
      <Explain id={id} value={value} />
    </span>
  )
}
