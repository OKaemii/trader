// Shared workspace-tab contract for the IA-redesign workspaces (Task 2).
//
// A workspace page is a server component that reads `?tab=` from `searchParams`
// and renders exactly one tab's async server component. `resolveTab` is the single
// source of truth for "which tab is active": an unknown or absent `?tab=` value
// falls back to the FIRST declared tab. Both the server page (to pick the element
// to render) and the client `WorkspaceTabs` (to highlight the active link) call it,
// so the SSR markup and the client-rendered active state can never disagree.

/** One workspace tab: `key` is the `?tab=` value, `label` is the tablist text. */
export interface WorkspaceTab {
  key: string
  label: string
}

/**
 * Resolve the active tab key from a (possibly missing/unknown) requested value.
 * Returns `requested` when it matches a declared tab; otherwise the first tab's key.
 *
 * `tabs` is required to be non-empty by every call site (each workspace declares a
 * `TABS as const` with ≥1 entry); when empty, returns `undefined` rather than
 * throwing so a misconfigured page degrades to "no active tab" instead of crashing.
 */
export function resolveTab(
  tabs: ReadonlyArray<WorkspaceTab>,
  requested: string | null | undefined,
): string | undefined {
  if (requested != null && tabs.some((t) => t.key === requested)) return requested
  return tabs[0]?.key
}
