'use client'

// Strategy-Lab pipeline funnel (plan: agent-docs/plans/research-trading-os.md, Task 3 §A).
//
// A custom inline-SVG horizontal stepper. Each node is a pipeline stage (Universe → Filter(s)
// → Rank → Top-K → Rebalance) carrying a label + a live count. The node's cross-section scales
// with its count so the funnel VISIBLY NARROWS left→right as the candidate set is winnowed
// (e.g. Universe 192 → QMJ 140 → Rank → Top-K 20 → Rebalance). Clicking a node calls onStage(key)
// so the parent can drill into that stage.
//
// Deliberately dependency-free: hand-rolled SVG geometry, no DAG/flow library. The shape is kept
// GENERIC — it knows nothing about strategies; Task 37 wires real GET /admin/api/strategy/<id>/pipeline
// data into it. Keep this contract stable for that consumer.

export interface PipelineStage {
  /** Stable stage identifier passed back through onStage (e.g. 'universe', 'qmj', 'topk'). */
  key: string
  /** Human-readable stage name rendered under the node. */
  label: string
  /** Live count at this stage. Drives the node's funnel cross-section (∝ count). */
  count: number
}

export interface PipelineFunnelProps {
  stages: PipelineStage[]
  /** Fired with the stage key when a node is activated (click or keyboard). */
  onStage?: (key: string) => void
}

// SVG layout constants (viewBox units; the <svg> scales responsively to its container width).
const NODE_W = 96 // per-stage horizontal slot
const GAP = 28 // edge length between successive nodes
const MAX_H = 92 // cross-section of the largest (first) stage
const MIN_H = 18 // floor so a tiny/zero count still renders a clickable target
const TOP_PAD = 16 // headroom above the tallest node for the count label
const BOTTOM_PAD = 30 // room below for the stage label
const VIEW_H = TOP_PAD + MAX_H + BOTTOM_PAD

export function PipelineFunnel({ stages, onStage }: PipelineFunnelProps) {
  if (stages.length === 0) {
    return (
      <div className="rounded-lg border border-gray-800 bg-gray-950 p-6 text-center text-sm text-gray-500">
        No pipeline stages.
      </div>
    )
  }

  // The first stage (largest set) defines full height; everything else scales relative to it, so
  // the visual narrowing is proportional to the real winnowing rather than absolute pixel counts.
  const peak = Math.max(...stages.map((s) => s.count), 1)
  const centreY = TOP_PAD + MAX_H / 2

  const viewW = stages.length * NODE_W + (stages.length - 1) * GAP

  const heightFor = (count: number) => {
    const scaled = (Math.max(count, 0) / peak) * MAX_H
    return Math.max(scaled, MIN_H)
  }

  const interactive = typeof onStage === 'function'

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950 p-4">
      <svg
        viewBox={`0 0 ${viewW} ${VIEW_H}`}
        className="h-auto w-full"
        role="list"
        aria-label="Strategy pipeline funnel"
      >
        {stages.map((stage, i) => {
          const x = i * (NODE_W + GAP)
          const h = heightFor(stage.count)
          const y = centreY - h / 2
          const cx = x + NODE_W / 2

          // Connector edge from the previous node's right face to this node's left face,
          // drawn at the shared centre line so the funnel reads as one continuous flow.
          const connector =
            i > 0 ? (
              <line
                x1={x - GAP}
                y1={centreY}
                x2={x}
                y2={centreY}
                stroke="currentColor"
                strokeWidth={2}
                className="text-gray-700"
              />
            ) : null

          const handleActivate = () => onStage?.(stage.key)

          return (
            <g key={stage.key} role="listitem">
              {connector}
              <g
                role={interactive ? 'button' : undefined}
                tabIndex={interactive ? 0 : undefined}
                aria-label={`${stage.label}: ${stage.count}`}
                onClick={interactive ? handleActivate : undefined}
                onKeyDown={
                  interactive
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          handleActivate()
                        }
                      }
                    : undefined
                }
                className={
                  interactive
                    ? 'cursor-pointer outline-none [&:focus-visible_rect]:stroke-emerald-400 [&:hover_rect]:fill-gray-800'
                    : undefined
                }
              >
                <rect
                  x={x}
                  y={y}
                  width={NODE_W}
                  height={h}
                  rx={6}
                  className="fill-gray-900 stroke-gray-700"
                  strokeWidth={1.5}
                />
                {/* Count: the load-bearing number — mono/tabular so digits don't jitter across stages. */}
                <text
                  x={cx}
                  y={y - 6}
                  textAnchor="middle"
                  className="fill-emerald-400 font-mono text-[13px] tabular-nums"
                >
                  {stage.count}
                </text>
                {/* Stage label under the funnel. */}
                <text
                  x={cx}
                  y={TOP_PAD + MAX_H + 18}
                  textAnchor="middle"
                  className="fill-gray-400 text-[11px]"
                >
                  {stage.label}
                </text>
              </g>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
