import { redirect } from 'next/navigation'

// The /charts route lives on as a redirect stub. The standalone Charts tab folded into
// the Research workspace's price/candlestick view, which Task 22 keys as `history` (the
// placeholder that Task 23 grows into the full per-symbol History tab). Old nav links,
// bookmarks, and the command palette resolve through here.
export default function ChartsPage() {
  redirect('/research?tab=history')
}
