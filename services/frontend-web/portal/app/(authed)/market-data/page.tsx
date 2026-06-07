import { redirect } from 'next/navigation'

// The operational Market Data admin (poll config / session calendar / holiday feeds) is a
// run-the-platform concern, so Task 22 relocated it from Research to the Operations
// workspace. Kept as a redirect stub so old nav links, bookmarks, and the command palette
// resolve.
export default function MarketDataPage() {
  redirect('/operations?tab=market-data')
}
