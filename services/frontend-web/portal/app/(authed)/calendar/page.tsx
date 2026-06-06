import { redirect } from 'next/navigation'

// The Earnings & Dividends calendar moved into the Discover workspace (Task 7). Kept as a redirect
// so old links / bookmarks don't 404. (Distinct from /market-data/calendar — the exchange-session
// schedule — which lives in the Research workspace.)
export default function CalendarPage() {
  redirect('/discover?tab=calendar')
}
