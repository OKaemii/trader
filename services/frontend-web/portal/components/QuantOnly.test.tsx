// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ModeProvider, useMode } from './ModeProvider'
import { QuantOnly } from './QuantOnly'

// Card #31's required local smoke: <QuantOnly> shows its children in quant mode and hides
// them in beginner mode, driven through the real <ModeProvider> context + useMode() seam.
// (The toggle's own server-action round trip is covered by authenticated QA; here we prove
// the client gate the way #43 will rely on it.)
describe('QuantOnly via ModeProvider', () => {
  it("renders children when mode is 'quant'", () => {
    render(
      <ModeProvider initial="quant">
        <QuantOnly>
          <div>advanced-panel</div>
        </QuantOnly>
      </ModeProvider>,
    )
    expect(screen.getByText('advanced-panel')).toBeInTheDocument()
  })

  it("hides children when mode is 'beginner'", () => {
    render(
      <ModeProvider initial="beginner">
        <QuantOnly>
          <div>advanced-panel</div>
        </QuantOnly>
      </ModeProvider>,
    )
    expect(screen.queryByText('advanced-panel')).not.toBeInTheDocument()
  })

  it('exposes the seeded mode through useMode()', () => {
    function Probe() {
      return <span>mode:{useMode()}</span>
    }
    render(
      <ModeProvider initial="beginner">
        <Probe />
      </ModeProvider>,
    )
    expect(screen.getByText('mode:beginner')).toBeInTheDocument()
  })
})
