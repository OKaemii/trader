'use client'
// Global ⌘K command palette (agent-docs/plans/portal-ia-redesign.md, then wired
// by epic-portal-post-redesign-fixes Task 1 — agent-docs/plans/portal-post-redesign-fixes.md).
//
// MOUNTING: a single <CommandPalette/> is mounted in app/(authed)/layout.tsx
// (inside the existing NuqsAdapter + TooltipProvider + ModeProvider) so the hotkey
// is live across the authed tree. It is self-contained — there is nothing for the
// layout to pass in.
//
// HYDRATION: `open` starts false, so on the server (and the first client render)
// cmdk's Command.Dialog renders nothing — no portal, no markup mismatch. The
// hotkey only flips it open after mount.
//
// ROUTES: the hrefs come from command-registry.ts and point at the live 6-workspace
// routes (locked by command-registry.test.ts + route-resolution.test.ts).
import * as RadixDialog from '@radix-ui/react-dialog'
import { Command } from 'cmdk'
import { useRouter } from 'next/navigation'
import { useCallback, useMemo, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { logout } from '@/app/actions/auth'
// setMode comes from the dedicated 'use server' module — NOT @/app/lib/mode, which
// carries `import 'server-only'` and would fail the build when pulled into this
// 'use client' component (AGENTS.md mode.ts gotcha).
import { setMode } from '@/app/lib/mode-actions'
import { COMMANDS, type Command as PaletteCommand } from '@/app/lib/command-registry'
import { useMode } from '@/components/ModeProvider'

export function CommandPalette() {
  const router = useRouter()
  const mode = useMode()
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
      // Navigation commands carry an href → jump to their route.
      if (cmd.href) {
        router.push(cmd.href)
        return
      }
      // Action commands carry no href and are dispatched by id. The registry +
      // command-registry.test.ts lock the action set to exactly
      // {act.toggle-mode, act.sign-out}, so this switch is exhaustive.
      switch (cmd.id) {
        case 'act.toggle-mode':
          // Mirror <ModeToggle/>: flip the display cookie, then router.refresh()
          // so server surfaces (getMode() + any <QuantOnly>) re-evaluate. Display
          // preference only — never a trading mutation, never gates safety controls.
          void setMode(mode === 'quant' ? 'beginner' : 'quant').then(() => router.refresh())
          break
        case 'act.sign-out':
          // Server action: deleteSession() + redirect('/login').
          void logout()
          break
      }
    },
    [router, mode],
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
