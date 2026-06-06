import { NextRequest, NextResponse } from 'next/server'

// Gate the ENTIRE authed surface: any route not in `publicRoutes` requires a session.
// This closes the gap where only a 5-route allow-list was protected and every other
// authed route (the workspaces /workspace,/discover,/build,/portfolio,/operations, …)
// rendered an empty shell instead of redirecting to /login. An authed user landing on a
// public route is bounced to /workspace (the post-login home).
const publicRoutes = ['/login']

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  const hasSession = req.cookies.has('rt')
  const isPublic = publicRoutes.includes(pathname)

  if (!isPublic && !hasSession) {
    return NextResponse.redirect(new URL('/login', req.nextUrl))
  }

  if (isPublic && hasSession) {
    return NextResponse.redirect(new URL('/workspace', req.nextUrl))
  }

  return NextResponse.next()
}

// `portal-api` is excluded from the matcher so an unauthenticated client `fetch('/portal-api/…')`
// returns its own 401 (via authedFetch) rather than a 307→/login HTML redirect that would break
// client-side data fetching. `_next/static`, `_next/image`, `favicon.ico`, and `api` stay excluded.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api|portal-api).*)'],
}
