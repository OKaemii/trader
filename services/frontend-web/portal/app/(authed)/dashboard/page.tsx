import { redirect } from 'next/navigation'

// The dashboard moved to the Workspace command center (/workspace). This stub keeps the old route
// — and the post-login redirect target (app/actions/auth.ts → /dashboard, flipped to /workspace by
// a later card) plus existing nav links/bookmarks — working: login → /dashboard → /workspace.
export default function Page() {
  redirect('/workspace')
}
