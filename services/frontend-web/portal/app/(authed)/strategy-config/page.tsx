import { redirect } from 'next/navigation'

// Strategy config moved into the Build workspace (IA-redesign Task 9). This stub keeps the old
// route — and any nav links/bookmarks — working: /strategy-config → /build?tab=strategy.
export default function Page() {
  redirect('/build?tab=strategy')
}
