// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Markdown } from './Markdown'

// Task 2's required local smoke: the shared <Markdown> renderer turns GFM into a
// React tree (headings, lists, tables) AND — the load-bearing guarantee for the
// notebook/drawer/narrative consumers (#31/#34/#35) — strips embedded raw HTML so a
// `<script>` or event-handler attribute smuggled into an operator note can never
// reach the DOM.
describe('Markdown', () => {
  it('renders GFM headings and lists', () => {
    const { container } = render(
      <Markdown>{'# Title\n\n- first\n- second\n'}</Markdown>,
    )
    expect(screen.getByText('Title').tagName).toBe('H1')
    expect(container.querySelectorAll('li')).toHaveLength(2)
    expect(screen.getByText('first')).toBeInTheDocument()
    expect(screen.getByText('second')).toBeInTheDocument()
  })

  it('renders a GFM table (remark-gfm enabled)', () => {
    const { container } = render(
      <Markdown>{'| a | b |\n| - | - |\n| 1 | 2 |\n'}</Markdown>,
    )
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.querySelectorAll('td')).toHaveLength(2)
  })

  it('strips a raw <script> tag (sanitizer is active)', () => {
    const { container } = render(
      <Markdown>{'ok text\n\n<script>window.__pwned = true</script>\n'}</Markdown>,
    )
    expect(container.querySelector('script')).toBeNull()
    expect(screen.getByText('ok text')).toBeInTheDocument()
  })

  it('strips raw HTML elements and event-handler attributes', () => {
    const { container } = render(
      <Markdown>
        {'before\n\n<img src="x" onerror="window.__pwned = true" />\n\n<div onclick="evil()">raw</div>\n'}
      </Markdown>,
    )
    // The default rehype-sanitize allowlist drops disallowed elements/attributes;
    // no element in the tree may carry an inline event handler.
    for (const el of Array.from(container.querySelectorAll('*'))) {
      expect(el.getAttribute('onerror')).toBeNull()
      expect(el.getAttribute('onclick')).toBeNull()
    }
    expect(screen.getByText('before')).toBeInTheDocument()
  })

  it('drops a javascript: URL from a link', () => {
    // Intentional XSS payload under test: the link target is a javascript: URL.
    const { container } = render(<Markdown>{'[click](javascript:alert(1))'}</Markdown>)
    const anchor = container.querySelector('a')
    // rehype-sanitize rejects the javascript: protocol, leaving the link without a
    // dangerous href (it becomes absent or empty, never the script URL).
    expect(anchor?.getAttribute('href') ?? '').not.toContain('javascript:')
  })
})
