import { redirect } from 'next/navigation'

// IA-redesign (Task 10): /operations/risk-limits moved into the Portfolio workspace. Kept as a
// redirect stub so nav links, bookmarks, and the operator-console hub keep working.
export default function Page() {
  redirect('/portfolio?tab=risk-limits')
}
