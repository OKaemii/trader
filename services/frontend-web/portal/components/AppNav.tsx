'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { logout } from '@/app/actions/auth'
import { WorldClock } from './WorldClock'

const links = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/positions', label: 'Positions' },
  { href: '/signals', label: 'Signals' },
  { href: '/research', label: 'Research' },
  { href: '/strategy-config', label: 'Strategy' },
  { href: '/universe', label: 'Universe' },
  { href: '/market-data', label: 'Market Data' },
  { href: '/operations/console', label: 'Console' },
  { href: '/operations/performance', label: 'Performance' },
  { href: '/operations/trade-audit', label: 'Trade Audit' },
  { href: '/operations/risk-limits', label: 'Risk Limits' },
  { href: '/operations/reconciliation', label: 'Reconciliation' },
  { href: '/operations/tca', label: 'TCA' },
]

export function AppNav() {
  const pathname = usePathname()
  return (
    <nav className="border-b border-gray-800 bg-gray-900">
      <div className="flex items-center justify-between px-6 py-3">
        <div className="flex items-center gap-1">
          <span className="mr-6 text-sm font-semibold text-gray-200">Trader</span>
          {links.map((l) => {
            const active = pathname === l.href || pathname.startsWith(l.href + '/')
            return (
              <Link
                key={l.href}
                href={l.href}
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
