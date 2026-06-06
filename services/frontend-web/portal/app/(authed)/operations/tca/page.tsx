import { redirect } from 'next/navigation'

// The TCA page moved into the Operations workspace (Task 11). Kept as a redirect so old links /
// bookmarks (incl. the operator console quick-link) don't 404.
export default function TcaPage() {
  redirect('/operations?tab=tca')
}
