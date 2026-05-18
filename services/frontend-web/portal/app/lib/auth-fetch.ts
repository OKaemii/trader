import 'server-only'
import { getAccessToken, getRefreshToken, rotateAccessToken } from './session'

// One dumb pipe. The portal's server-side fetches go through nginx-ingress, which
// path-prefix-routes to the right service. Each service authenticates itself via its
// own audience-based middleware — no central gateway, no central auth.
//
// INGRESS_URL points at the cluster's nginx-ingress-controller (in-cluster) by default;
// override for local dev where the ingress controller has a different name. INGRESS_HOST
// is the virtual host the cluster ingress rules are scoped to (matches the `host:` field
// in each service's Ingress resource).
const INGRESS_URL  = process.env.INGRESS_URL  ?? 'http://ingress-nginx-controller.ingress-nginx.svc.cluster.local:80'
const INGRESS_HOST = process.env.INGRESS_HOST ?? 'trader.local'

function ingressFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${INGRESS_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Host: INGRESS_HOST,
    },
  })
}

async function refreshAccessToken(refreshToken: string): Promise<string | null> {
  const res = await ingressFetch('/api/auth/refresh', {
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
    ingressFetch(path, {
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

  try {
    await rotateAccessToken(newAt)
  } catch {
    // intentionally ignored — cookie mutations are only legal in Server Actions / Route Handlers
  }
  return tryFetch(newAt)
}

export { INGRESS_URL, INGRESS_HOST }
