'use client'
// Deep-linkable workspace tablist (IA-redesign Task 2). Each tab is a real URL
// (`<pathname>?tab=<key>`) so a tab selection is shareable, survives reload, and
// SSRs correctly — that's why this is plain <Link> navigation, NOT the Radix
// ui/Tabs primitive (which is for in-page, non-routed sub-views).
//
// Active tab is read from `?tab=` and resolved with the SAME `resolveTab` helper the
// server page uses, so the highlighted link always matches the rendered tab content.
// The page passes its server-resolved `active` as the SSR fallback so the correct
// tab is highlighted on first paint (no flash of the default tab before hydration);
// once mounted, the live URL via `useSearchParams` takes over for instant feedback.
//
// IMPORTANT: `useSearchParams()` requires a <Suspense> boundary in the App Router —
// the caller MUST render this inside one. `WorkspaceShell` does exactly that, so use
// the shell rather than mounting this bare.
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { resolveTab, type WorkspaceTab } from '@/app/lib/tabs'
import { cn } from '@/components/ui/cn'

export function WorkspaceTabs({
  tabs,
  active: serverActive,
}: {
  tabs: ReadonlyArray<WorkspaceTab>
  active?: string | undefined
}) {
  const pathname = usePathname()
  const params = useSearchParams()
  const active = resolveTab(tabs, params.get('tab') ?? serverActive)
  // Preserve the entity context across a tab switch: the Research symbol workspace deep-links
  // as `?symbol=<sym>&tab=<key>`, so a tab link that dropped `symbol` would bounce back to the
  // no-symbol landing. `symbol` is the only cross-tab query param in the IA; other workspaces
  // simply have none, so this is a no-op there.
  const symbol = params.get('symbol')
  const hrefFor = (key: string) =>
    symbol ? `${pathname}?symbol=${encodeURIComponent(symbol)}&tab=${key}` : `${pathname}?tab=${key}`
  return (
    <div role="tablist" className="flex gap-1 border-b border-gray-800">
      {tabs.map((t) => {
        const on = t.key === active
        return (
          <Link
            key={t.key}
            role="tab"
            aria-selected={on}
            href={hrefFor(t.key)}
            className={cn(
              'rounded-t px-3 py-2 text-sm transition-colors',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500',
              on
                ? 'border-b-2 border-emerald-500 text-white'
                : 'text-gray-400 hover:text-gray-100',
            )}
          >
            {t.label}
          </Link>
        )
      })}
    </div>
  )
}
