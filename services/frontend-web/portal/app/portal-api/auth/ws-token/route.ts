import { NextResponse } from 'next/server'
import { getAccessToken, getRefreshToken, rotateAccessToken, deleteSession } from '@/app/lib/session'

const INGRESS_URL  = process.env.INGRESS_URL  ?? 'http://ingress-nginx-controller.ingress-nginx.svc.cluster.local:80'
const INGRESS_HOST = process.env.INGRESS_HOST ?? 'trader.local'

export async function GET() {
  let token = await getAccessToken()

  if (!token) {
    const rt = await getRefreshToken()
    if (!rt) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const res = await fetch(`${INGRESS_URL}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: INGRESS_HOST },
      body: JSON.stringify({ refreshToken: rt }),
    })
    if (!res.ok) {
      await deleteSession()
      return NextResponse.json({ error: 'Session expired' }, { status: 401 })
    }
    const { accessToken } = await res.json()
    await rotateAccessToken(accessToken)
    token = accessToken
  }

  return NextResponse.json({ token })
}
