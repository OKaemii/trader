import { NextResponse } from 'next/server'
import { getAccessToken, getRefreshToken, rotateAccessToken, deleteSession } from '@/app/lib/session'

const GATEWAY = process.env.GATEWAY_URL ?? 'http://api-gateway:3000'

export async function GET() {
  let token = await getAccessToken()

  if (!token) {
    const rt = await getRefreshToken()
    if (!rt) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const res = await fetch(`${GATEWAY}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
