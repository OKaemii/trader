import { redirect } from 'next/navigation'

// IA-redesign (Task 10): the /risk/trips LIST moved into the Portfolio workspace. Kept as a redirect
// stub so nav links, bookmarks, the operator-console hub, and the CircuitBreakerCard keep working.
// The per-trip DETAIL stays a real route at /risk/trips/[id] (it is not redirected).
export default function Page() {
  redirect('/portfolio?tab=trips')
}
