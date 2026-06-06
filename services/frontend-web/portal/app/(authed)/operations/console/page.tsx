import { redirect } from 'next/navigation'

// The operations console moved into the Build workspace (IA-redesign Task 9). This stub keeps the
// old route — and any nav links/bookmarks — working: /operations/console → /build?tab=console.
export default function Page() {
  redirect('/build?tab=console')
}
