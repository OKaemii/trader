import { redirect } from 'next/navigation'

// The session/holiday calendar lives in the operational Market Data admin, which Task 22
// relocated from Research to the Operations workspace. Kept as a redirect stub so old nav
// links and bookmarks resolve.
export default function MarketDataCalendarPage() {
  redirect('/operations?tab=market-data')
}
