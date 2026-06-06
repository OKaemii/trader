import { redirect } from 'next/navigation'

// The Sectors page moved into the Discover workspace (Task 7). Kept as a redirect so old links /
// bookmarks don't 404.
export default function SectorsPage() {
  redirect('/discover?tab=sectors')
}
