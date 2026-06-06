import { NuqsAdapter } from 'nuqs/adapters/next/app'
import { AppNav } from '@/components/AppNav'
import { TooltipProvider } from '@/components/ui/Tooltip'

// Cross-cutting providers for the workspace IA mount once here, wrapping the whole
// authed tree:
//   - NuqsAdapter   — backs URL-addressable `?tab=` / search-param state (Task 2+).
//   - TooltipProvider — shared Radix tooltip context for the learning layer (Task 5).
// Later cards add ModeProvider + <CommandPalette/> around these (Task 12); this card
// only introduces the two foundational providers.
export default function AuthedLayout({ children }: { children: React.ReactNode }) {
  return (
    <NuqsAdapter>
      <TooltipProvider delayDuration={200}>
        <div className="min-h-screen bg-gray-950">
          <AppNav />
          <main>{children}</main>
        </div>
      </TooltipProvider>
    </NuqsAdapter>
  )
}
