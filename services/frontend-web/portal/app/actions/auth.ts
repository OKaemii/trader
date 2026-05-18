'use server'
import { redirect } from 'next/navigation'
import { createSession, deleteSession } from '@/app/lib/session'

const INGRESS_URL  = process.env.INGRESS_URL  ?? 'http://ingress-nginx-controller.ingress-nginx.svc.cluster.local:80'
const INGRESS_HOST = process.env.INGRESS_HOST ?? 'trader.local'

export async function login(
  _prevState: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error: string }> {
  const email = formData.get('email') as string
  const password = formData.get('password') as string

  if (!email || !password) return { error: 'Email and password required' }

  let res: Response
  try {
    res = await fetch(`${INGRESS_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: INGRESS_HOST },
      body: JSON.stringify({ email, password }),
    })
  } catch {
    return { error: 'Cannot reach auth service — try again later' }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    return { error: body.error ?? 'Invalid credentials' }
  }

  const { accessToken, refreshToken } = await res.json()
  await createSession(accessToken, refreshToken)
  redirect('/dashboard')
}

export async function logout() {
  await deleteSession()
  redirect('/login')
}
