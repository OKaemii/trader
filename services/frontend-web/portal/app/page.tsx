import { redirect } from 'next/navigation';

// The proxy gates this route: an unauthenticated GET of `/` is redirected to `/login`
// before this component runs, so only an authenticated user reaches here — send them
// straight to the post-login home. (No loop: authed `/` → `/workspace`; unauth `/` → `/login`.)
export default function Home() {
  redirect('/workspace');
}
