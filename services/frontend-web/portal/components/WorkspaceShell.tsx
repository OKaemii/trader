import { Suspense } from 'react'
import { WorkspaceTabs } from '@/components/WorkspaceTabs'
import type { WorkspaceTab } from '@/app/lib/tabs'

// Shared chrome for every IA-redesign workspace (Task 2): the page title, the
// deep-linkable `?tab=` tablist, and the active tab's content as `children`.
//
// This is a SERVER component. The owning page (also a server component) computes
// the active tab from `searchParams` with `resolveTab`, renders only that tab's
// async server child into `children`, and passes the same `active` here. The tablist
// is a client component that re-reads `?tab=` from the URL; it lives behind a
// <Suspense> boundary because `useSearchParams()` requires one in the App Router.
// `active` is forwarded to the tablist as its SSR-render fallback so the right tab is
// highlighted on first paint, before hydration reads the live URL.
export function WorkspaceShell({
  title,
  tabs,
  active,
  children,
}: {
  title: string
  tabs: ReadonlyArray<WorkspaceTab>
  active: string | undefined
  children: React.ReactNode
}) {
  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold text-white">{title}</h1>
      <Suspense>
        <WorkspaceTabs tabs={tabs} active={active} />
      </Suspense>
      {children}
    </div>
  )
}
