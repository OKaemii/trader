import { redirect } from 'next/navigation'

// IA-redesign Task 8: /market-data moved into the Research workspace as the Market Data
// tab. Kept as a redirect stub so old nav links, bookmarks, and the command palette resolve.
export default function MarketDataPage() {
  redirect('/research?tab=market-data')
}
