import 'server-only'
import { getAccessToken, getRefreshToken, rotateAccessToken, deleteSession } from './session'

const GATEWAY = process.env.GATEWAY_URL ?? 'http://api-gateway:3000'

async function refreshAccessToken(refreshToken: string): Promise<string | null> {
  const res = await fetch(`${GATEWAY}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  })
  if (!res.ok) return null
  const { accessToken } = await res.json()
  return accessToken ?? null
}

export async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  let at = await getAccessToken()
  const rt = await getRefreshToken()

  if (!at && !rt) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const tryFetch = (token: string) =>
    fetch(`${GATEWAY}${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
    })

  if (at) {
    const res = await tryFetch(at)
    if (res.status !== 401) return res
  }

  if (!rt) {
    return new Response(JSON.stringify({ error: 'Session expired' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const newAt = await refreshAccessToken(rt)
  if (!newAt) {
    await deleteSession()
    return new Response(JSON.stringify({ error: 'Session expired' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  await rotateAccessToken(newAt)
  return tryFetch(newAt)
}

export { GATEWAY }
