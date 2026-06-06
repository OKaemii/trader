import { redirect } from 'next/navigation'

// The Scanner was merged into the Universe view (one place for "what the universe is + why"), now
// the Universe tab of the Discover workspace (Task 7). Kept as a redirect so old links / bookmarks /
// the console quick-link don't 404.
export default function ScannerPage() {
  redirect('/discover?tab=universe')
}
