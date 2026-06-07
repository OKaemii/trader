// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Task 3 (epic-research-trading-os): the PipelineFunnel renders one node per stage with its label
// + live count, and clicking a node hands the stage KEY (not the index/label) back to onStage so
// the parent can drill in. Task 37 wires real strategy-pipeline data into this generic contract,
// so these tests pin the shape it depends on.
import { PipelineFunnel, type PipelineStage } from './PipelineFunnel'

const STAGES: PipelineStage[] = [
  { key: 'universe', label: 'Universe', count: 192 },
  { key: 'qmj', label: 'QMJ', count: 140 },
  { key: 'rank', label: 'Rank', count: 140 },
  { key: 'topk', label: 'Top-K', count: 20 },
  { key: 'rebalance', label: 'Rebalance', count: 20 },
]

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PipelineFunnel', () => {
  it('renders one node per stage with its label and count', () => {
    render(<PipelineFunnel stages={STAGES} />)

    // One accessible node per stage, each labelled "<label>: <count>".
    const nodes = screen.getAllByRole('listitem')
    expect(nodes).toHaveLength(STAGES.length)

    for (const s of STAGES) {
      expect(screen.getByText(s.label)).toBeInTheDocument()
    }
    // Counts (including the repeated 140 / 20) render once per stage.
    expect(screen.getAllByText('192')).toHaveLength(1)
    expect(screen.getAllByText('140')).toHaveLength(2)
    expect(screen.getAllByText('20')).toHaveLength(2)
  })

  it('fires onStage with the clicked stage key', () => {
    const onStage = vi.fn()
    render(<PipelineFunnel stages={STAGES} onStage={onStage} />)

    fireEvent.click(screen.getByRole('button', { name: 'Top-K: 20' }))

    expect(onStage).toHaveBeenCalledTimes(1)
    expect(onStage).toHaveBeenCalledWith('topk')
  })

  it('activates a node from the keyboard (Enter)', () => {
    const onStage = vi.fn()
    render(<PipelineFunnel stages={STAGES} onStage={onStage} />)

    fireEvent.keyDown(screen.getByRole('button', { name: 'Universe: 192' }), { key: 'Enter' })

    expect(onStage).toHaveBeenCalledWith('universe')
  })

  it('renders non-interactive nodes (no button role) when onStage is absent', () => {
    render(<PipelineFunnel stages={STAGES} />)

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    // Still renders the stages as a list.
    expect(screen.getAllByRole('listitem')).toHaveLength(STAGES.length)
  })

  it('renders an empty-state when there are no stages', () => {
    render(<PipelineFunnel stages={[]} />)

    expect(screen.getByText(/no pipeline stages/i)).toBeInTheDocument()
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })
})
