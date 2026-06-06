import { redirect } from 'next/navigation'

// The Universe page moved into the Discover workspace (Task 7). Kept as a redirect so old links /
// bookmarks / the console quick-link don't 404.
export default function UniversePage() {
  redirect('/discover?tab=universe')
}
