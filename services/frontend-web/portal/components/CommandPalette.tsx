'use client'
// Global ⌘K command palette (Task 4 — agent-docs/plans/portal-ia-redesign.md).
//
// MOUNTING: this component is intentionally NOT mounted yet. Task 12 mounts a
// single <CommandPalette/> in app/(authed)/layout.tsx (inside the existing
// NuqsAdapter + TooltipProvider) so the hotkey is live across the authed tree.
// It is self-contained — drop it in once and it listens for ⌘K everywhere; there
// is nothing for the layout to pass in.
//
// HYDRATION: `open` starts false, so on the server (and the first client render)
// cmdk's Command.Dialog renders nothing — no portal, no markup mismatch. The
// hotkey only flips it open after mount.
//
// ROUTES: the hrefs come from command-registry.ts and point at the planned
// workspace routes, several of which 404 until Tasks 6–11 land. That is expected
// for this card; Task 16 reconciles the registry against the real routes.
import * as RadixDialog from '@radix-ui/react-dialog'
import { Command } from 'cmdk'
import { useRouter } from 'next/navigation'
import { useCallback, useMemo, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { COMMANDS, type Command as PaletteCommand } from '@/app/lib/command-registry'

export function CommandPalette() {
  const router = useRouter()
  const [open, setOpen] = useState(false)

  // ⌘K (Mac) / Ctrl+K (Win/Linux). preventDefault so the browser's own
  // ⌘K (focus address bar / search) doesn't also fire. enableOnFormTags:false
  // keeps the chord from hijacking keystrokes while a user is typing in an input
  // elsewhere in the app (the palette's own input is rendered inside the dialog,
  // which is unmounted while closed, so toggling-closed-from-inside still works).
  useHotkeys(
    'mod+k',
    (e) => {
      e.preventDefault()
      setOpen((o) => !o)
    },
    { enableOnFormTags: false },
  )

  const onSelect = useCallback(
    (cmd: PaletteCommand) => {
      setOpen(false)
      // Navigation commands jump to their route. Action commands (no href —
      // toggle mode, sign out) are wired to real behaviour by Task 12 when this
      // is mounted; here they simply dismiss the palette so the contract
      // (close-on-select) holds and nothing throws in the dormant state.
      if (cmd.href) router.push(cmd.href)
    },
    [router],
  )

  // Stable group order, derived from the registry so new groups appear without
  // editing this file. Within a group, registry order is preserved.
  const groups = useMemo(() => {
    const byGroup = new Map<string, PaletteCommand[]>()
    for (const cmd of COMMANDS) {
      const list = byGroup.get(cmd.group)
      if (list) list.push(cmd)
      else byGroup.set(cmd.group, [cmd])
    }
    return [...byGroup.entries()]
  }, [])

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      loop
      overlayClassName="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm"
      contentClassName="fixed left-1/2 top-[20%] z-50 w-full max-w-lg -translate-x-1/2 overflow-hidden rounded-lg border border-gray-800 bg-gray-900 text-gray-200 shadow-xl focus:outline-none"
    >
      {/* Screen-reader title/description for the underlying Radix dialog. cmdk
          renders these children inside its Dialog.Content and shares the single
          deduped @radix-ui/react-dialog instance, so they register with that
          dialog's context and satisfy its a11y requirement (otherwise Radix
          logs a missing-DialogTitle warning). Visually hidden — the visible
          affordance is the input below. */}
      <RadixDialog.Title className="sr-only">Command palette</RadixDialog.Title>
      <RadixDialog.Description className="sr-only">
        Search for a workspace, tab, or action and press Enter to run it.
      </RadixDialog.Description>
      <Command.Input
        placeholder="Jump to a workspace, tab, or action…"
        className="w-full border-b border-gray-800 bg-transparent px-4 py-3 text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none"
      />
      <Command.List className="max-h-80 overflow-y-auto overflow-x-hidden p-2">
        <Command.Empty className="px-3 py-6 text-center text-sm text-gray-500">
          No results.
        </Command.Empty>
        {groups.map(([group, cmds]) => (
          <Command.Group
            key={group}
            heading={group}
            className="px-1 py-1 text-xs font-medium text-gray-500 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
          >
            {cmds.map((cmd) => (
              <Command.Item
                key={cmd.id}
                value={`${cmd.label} ${(cmd.keywords ?? []).join(' ')}`}
                keywords={cmd.keywords}
                onSelect={() => onSelect(cmd)}
                className="flex cursor-pointer items-center rounded px-3 py-2 text-sm text-gray-300 aria-selected:bg-gray-800 aria-selected:text-white"
              >
                {cmd.label}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command.Dialog>
  )
}
