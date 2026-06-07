import { NuqsAdapter } from 'nuqs/adapters/next/app'
import { AppNav } from '@/components/AppNav'
import { CommandPalette } from '@/components/CommandPalette'
import { ModeProvider } from '@/components/ModeProvider'
import { DrawerProvider } from '@/components/ResearchDrawer'
import { TooltipProvider } from '@/components/ui/Tooltip'
import { getMode } from '@/app/lib/mode'

// Cross-cutting providers for the workspace IA mount once here, wrapping the whole
// authed tree (Task 12 — agent-docs/plans/portal-ia-redesign.md):
//   - NuqsAdapter     — backs URL-addressable `?tab=` / search-param state.
//   - TooltipProvider — shared Radix tooltip context for the learning layer.
//   - ModeProvider    — Beginner⇄Quant complexity mode, seeded from the server-read
//     cookie (`getMode()`) so the first client paint already matches the SSR markup
//     (no flash). <ModeToggle/> in the nav and any <QuantOnly> read it via useMode().
//   - DrawerProvider  — the universal research drawer (research-trading-os Task 1);
//     any authed component opens the right-anchored symbol slide-over via
//     useResearchDrawer().open(symbol). Mounts the single <Drawer> overlay itself.
// <CommandPalette/> is the always-mounted global ⌘K island (self-contained, no props);
// mounting it once here makes the chord live across the authed surface.
export default async function AuthedLayout({ children }: { children: React.ReactNode }) {
  const mode = await getMode()
  return (
    <NuqsAdapter>
      <TooltipProvider delayDuration={200}>
        <ModeProvider initial={mode}>
          <DrawerProvider>
            <div className="min-h-screen bg-gray-950">
              <AppNav />
              <CommandPalette />
              <main>{children}</main>
            </div>
          </DrawerProvider>
        </ModeProvider>
      </TooltipProvider>
    </NuqsAdapter>
  )
}
