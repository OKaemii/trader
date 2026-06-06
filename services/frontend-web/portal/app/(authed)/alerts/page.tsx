import { redirect } from 'next/navigation'

// Alerts moved into the Build workspace (IA-redesign Task 9). This stub keeps the old route — and
// any nav links/bookmarks — working: /alerts → /build?tab=alerts.
export default function Page() {
  redirect('/build?tab=alerts')
}
