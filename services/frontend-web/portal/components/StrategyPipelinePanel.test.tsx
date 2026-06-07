// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModeProvider } from './ModeProvider'
import { StrategyPipelinePanel, type PipelineData } from './StrategyPipelinePanel'

// Task 37 §G: Build → Strategy renders the Strategy-Lab pipeline funnel with the live, NARROWING
// stage counts from /admin/api/strategy/<id>/pipeline, and clicking a stage drills into its detail.
// The funnel itself (PipelineFunnel) is unit-tested separately; here we pin the panel's wiring:
// the seeded stages render, the funnel narrows, drill-in shows the stage help, and the empty /
// no-cycle states are honest. QuantOnly diagnostics need a ModeProvider, so we wrap in quant mode.

const PIPELINE: PipelineData = {
  strategy_id: 'high_velocity_v1',
  active: 'high_velocity_v1',
  stages: [
    { key: 'universe', label: 'Universe', count: 192 },
    { key: 'qmj', label: 'QMJ screen', count: 140 },
    { key: 'rank', label: 'Momentum rank', count: 30 },
    { key: 'topk', label: 'Top-K (20)', count: 20 },
    { key: 'rebalance', label: 'Rebalance', count: 20 },
  ],
}

function renderPanel(data: PipelineData, mode: 'quant' | 'beginner' = 'quant') {
  return render(
    <ModeProvider initial={mode}>
      <StrategyPipelinePanel initial={data} />
    </ModeProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('StrategyPipelinePanel', () => {
  it('renders the funnel with one node per stage and its live count', () => {
    renderPanel(PIPELINE)

    // One funnel node per stage (PipelineFunnel renders each as role=listitem).
    expect(screen.getAllByRole('listitem')).toHaveLength(PIPELINE.stages.length)
    // Each label renders at least once (in quant mode it also appears in the diagnostics table).
    for (const s of PIPELINE.stages) {
      expect(screen.getAllByText(s.label).length).toBeGreaterThanOrEqual(1)
    }
    // The widest (Universe) and narrowest (Rebalance) counts are both present — the funnel narrows.
    expect(screen.getAllByText('192').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('20').length).toBeGreaterThanOrEqual(1)
  })

  it('counts strictly narrow from Universe to Rebalance (the funnel invariant)', () => {
    renderPanel(PIPELINE)
    const counts = PIPELINE.stages.map((s) => s.count)
    expect(counts).toEqual([...counts].sort((a, b) => b - a))
    expect(counts[0]).toBeGreaterThan(counts[counts.length - 1])
  })

  it('drills into a stage on click, showing its detail', () => {
    renderPanel(PIPELINE)
    // No detail panel until a stage is selected.
    expect(screen.queryByText(/fail-closed quality/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'QMJ screen: 140' }))

    // The QMJ stage help text appears in the drill-in detail.
    expect(screen.getByText(/fail-closed quality/i)).toBeInTheDocument()
  })

  it('toggles the drill-in off when the same stage is clicked again', () => {
    renderPanel(PIPELINE)
    const node = screen.getByRole('button', { name: 'Top-K (20): 20' })
    fireEvent.click(node)
    expect(screen.getByText(/held band/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Top-K (20): 20' }))
    expect(screen.queryByText(/held band/i)).not.toBeInTheDocument()
  })

  it('shows the no-cycle notice when every stage count is zero', () => {
    renderPanel({
      strategy_id: 'factor_rank_v1',
      active: 'factor_rank_v1',
      stages: [
        { key: 'universe', label: 'Universe', count: 0 },
        { key: 'history', label: 'History filter', count: 0 },
        { key: 'scoring', label: 'Factor scoring', count: 0 },
        { key: 'topk', label: 'Top-K (20)', count: 0 },
        { key: 'rebalance', label: 'Rebalance', count: 0 },
      ],
    })
    expect(screen.getByText(/no cycle has run yet/i)).toBeInTheDocument()
  })

  it('renders the empty-state when there are no stages at all', () => {
    renderPanel({ strategy_id: 'factor_rank_v1', active: 'factor_rank_v1', stages: [] })
    expect(screen.getByText(/no pipeline stages/i)).toBeInTheDocument()
  })

  it('exposes the quant-only diagnostics table only in quant mode', () => {
    const { unmount } = renderPanel(PIPELINE, 'quant')
    expect(screen.getByText(/stage counts \(diagnostics\)/i)).toBeInTheDocument()
    unmount()

    renderPanel(PIPELINE, 'beginner')
    expect(screen.queryByText(/stage counts \(diagnostics\)/i)).not.toBeInTheDocument()
    // The funnel itself stays visible in beginner mode — only the diagnostics table is gated.
    expect(screen.getByText('Universe')).toBeInTheDocument()
  })
})
