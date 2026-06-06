import { redirect } from 'next/navigation'

// The Trade Audit page moved into the Operations workspace (Task 11). Kept as a redirect so old
// links / bookmarks (incl. the operator console quick-link) don't 404.
export default function TradeAuditPage() {
  redirect('/operations?tab=trade-audit')
}
