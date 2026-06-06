import { redirect } from 'next/navigation'

// IA-redesign Task 8: the session/holiday calendar moved into the Research workspace's
// Market Data tab. Kept as a redirect stub so old nav links and bookmarks resolve.
export default function MarketDataCalendarPage() {
  redirect('/research?tab=market-data')
}
