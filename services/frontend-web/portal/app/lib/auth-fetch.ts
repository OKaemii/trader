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
  const at = await getAccessToken()
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
    // Cannot await deleteSession() from a Server Component context — Next.js forbids
    // cookie mutations outside Server Actions / Route Handlers. The cookie will simply
    // expire on its own; the next request will re-prompt login.
    return new Response(JSON.stringify({ error: 'Session expired' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // rotateAccessToken would persist the refreshed token, but cookie mutations are only
  // legal in Server Actions / Route Handlers. Swallow the error so callers from RSCs
  // still get a valid response — the next call will just refresh again.
  try {
    await rotateAccessToken(newAt)
  } catch {
    // intentionally ignored — see comment above
  }
  return tryFetch(newAt)
}

export { GATEWAY }
