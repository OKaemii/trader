import { NextRequest, NextResponse } from 'next/server'

const protectedRoutes = ['/dashboard', '/signals', '/universe', '/market-data']
const publicRoutes = ['/login']

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  const hasSession = req.cookies.has('rt')

  const isProtected = protectedRoutes.some(
    (r) => pathname === r || pathname.startsWith(r + '/'),
  )
  const isPublic = publicRoutes.includes(pathname)

  if (isProtected && !hasSession) {
    return NextResponse.redirect(new URL('/login', req.nextUrl))
  }

  if (isPublic && hasSession) {
    return NextResponse.redirect(new URL('/dashboard', req.nextUrl))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api).*)'],
}
