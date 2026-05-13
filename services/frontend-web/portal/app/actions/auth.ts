'use server'
import { redirect } from 'next/navigation'
import { createSession, deleteSession } from '@/app/lib/session'

const GATEWAY = process.env.GATEWAY_URL ?? 'http://api-gateway:3000'

export async function login(
  _prevState: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error: string }> {
  const email = formData.get('email') as string
  const password = formData.get('password') as string

  if (!email || !password) return { error: 'Email and password required' }

  let res: Response
  try {
    res = await fetch(`${GATEWAY}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
