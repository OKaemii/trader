import { redirect } from 'next/navigation'

// The Scanner was merged into the Universe page (one place for "what the universe is + why").
// Kept as a redirect so old links / bookmarks / the console quick-link don't 404.
export default function ScannerPage() {
  redirect('/universe')
}
