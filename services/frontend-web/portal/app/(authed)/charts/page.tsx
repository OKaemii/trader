import { redirect } from 'next/navigation'

// IA-redesign Task 8: /charts moved into the Research workspace as the Charts tab.
// Kept as a redirect stub so old nav links, bookmarks, and the command palette resolve.
export default function ChartsPage() {
  redirect('/research?tab=charts')
}
