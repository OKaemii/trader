import { redirect } from 'next/navigation'

// IA-redesign Task 8: the signals LIST moved into the Research workspace as the Signals
// tab. Kept as a redirect stub so old nav links and bookmarks resolve. The /signals/[id]
// detail page (the notification-email target) is a SEPARATE real route owned by another
// card — it lives at signals/[id]/page.tsx and must NOT be redirected.
export default function SignalsPage() {
  redirect('/research?tab=signals')
}
