'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { logout } from '@/app/actions/auth'
import { ModeToggle } from './ModeToggle'
import { WorldClock } from './WorldClock'

// The new workflow-oriented IA: six workspaces replacing the old flat 18-link list
// (Task 12 — agent-docs/plans/portal-ia-redesign.md). Each workspace owns its internal
// `?tab=` surfaces; the nav only links the workspace root. Order follows the quant's
// pipeline: Workspace (home) → Discover → Research → Build → Portfolio → Operations.
const links = [
  { href: '/workspace', label: 'Workspace' },
  { href: '/discover', label: 'Discover' },
  { href: '/research', label: 'Research' },
  { href: '/build', label: 'Build' },
  { href: '/portfolio', label: 'Portfolio' },
  { href: '/operations', label: 'Operations' },
] as const

// A link is active for its own page and any deeper route/tab under it. `/workspace`
// has no children so this is effectively an exact match; `/operations` etc. also match
// `/operations?tab=…` (the query string is not part of `pathname`, so a workspace with
// tabs still matches on its base path) and any future nested segment.
function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + '/')
}

export function AppNav() {
  const pathname = usePathname()
  return (
    <nav className="border-b border-gray-800 bg-gray-900">
      <div className="flex items-center justify-between px-6 py-3">
        <div className="flex items-center gap-1">
          <span className="mr-6 text-sm font-semibold text-gray-200">Trader</span>
          {links.map((l) => {
            const active = isActive(pathname, l.href)
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? 'page' : undefined}
                className={
                  'rounded px-3 py-1.5 text-sm transition-colors ' +
                  (active
                    ? 'bg-gray-800 text-white'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-gray-100')
                }
              >
                {l.label}
              </Link>
            )
          })}
        </div>
        <div className="flex items-center gap-4">
          {/* Hint for the global ⌘K palette mounted in (authed)/layout.tsx. The chord
              itself is handled by <CommandPalette/>; this is a non-interactive
              affordance so users discover the shortcut. */}
          <span
            aria-hidden="true"
            title="Press ⌘K (Ctrl+K) to open the command palette"
            className="hidden items-center gap-1 rounded border border-gray-700 px-2 py-1 text-xs text-gray-500 sm:inline-flex"
          >
            <kbd className="font-sans">⌘K</kbd>
          </span>
          <ModeToggle />
          <WorldClock />
          <form action={logout}>
            <button
              type="submit"
              className="text-xs text-gray-500 transition-colors hover:text-gray-300"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </nav>
  )
}
