import { redirect } from 'next/navigation'

// The Screener page moved into the Discover workspace (Task 7). Kept as a redirect so old links /
// bookmarks don't 404.
export default function ScreenerPage() {
  redirect('/discover?tab=screener')
}
