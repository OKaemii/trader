'use client'
import { useActionState } from 'react'
import { login } from '@/app/actions/auth'

export default function LoginPage() {
  const [state, action, pending] = useActionState(login, undefined)

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="bg-gray-900 rounded-lg p-8 w-full max-w-sm shadow-xl">
        <h1 className="text-xl font-bold text-white mb-1">Trader Portal</h1>
        <p className="text-gray-500 text-sm mb-6">Sign in to your account</p>
        <form action={action} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-xs text-gray-400 mb-1">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className="w-full bg-gray-800 text-white rounded px-3 py-2 text-sm border border-gray-700 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-xs text-gray-400 mb-1">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="w-full bg-gray-800 text-white rounded px-3 py-2 text-sm border border-gray-700 focus:outline-none focus:border-blue-500"
            />
          </div>
          {state?.error && (
            <p className="text-red-400 text-sm">{state.error}</p>
          )}
          <button
            type="submit"
            disabled={pending}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded px-3 py-2 text-sm font-medium transition-colors"
          >
            {pending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
