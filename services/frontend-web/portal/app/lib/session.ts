import 'server-only'
import { cookies } from 'next/headers'

// `secure` must match the scheme the portal is served over. Browsers reject Secure
// cookies on plain HTTP, so tying it to NODE_ENV=production is wrong when the ingress
// is HTTP. Set COOKIE_SECURE=true in Helm values when you put TLS in front of the portal.
const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === 'true',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 7 * 24 * 60 * 60,
}

export async function createSession(accessToken: string, refreshToken: string) {
  const jar = await cookies()
  jar.set('at', accessToken, COOKIE_OPTS)
  jar.set('rt', refreshToken, COOKIE_OPTS)
}

export async function deleteSession() {
  const jar = await cookies()
  jar.delete('at')
  jar.delete('rt')
}

export async function getAccessToken(): Promise<string | null> {
  return (await cookies()).get('at')?.value ?? null
}

export async function getRefreshToken(): Promise<string | null> {
  return (await cookies()).get('rt')?.value ?? null
}

export async function rotateAccessToken(newAccessToken: string) {
  const jar = await cookies()
  jar.set('at', newAccessToken, COOKIE_OPTS)
}
