import 'server-only'
import { cookies } from 'next/headers'

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
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
