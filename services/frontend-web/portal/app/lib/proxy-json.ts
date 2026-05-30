import { NextResponse } from 'next/server'

/**
 * Forward an upstream service Response to the browser as guaranteed-valid JSON.
 *
 * The proxy routes can't assume the upstream body is JSON: a backend 500 (plain-text
 * "Internal Server Error"), an nginx 502/504 gateway page (HTML), or an empty body all yield
 * non-JSON. Passing those through with a `Content-Type: application/json` header makes the
 * browser's `res.json()` blow up with "JSON.parse: unexpected character at line 1 column 1",
 * hiding the real failure. Here we read the body as text, return it untouched when it parses as
 * JSON, and otherwise wrap it into `{ detail }` so callers always get a readable message.
 */
export async function forwardJson(res: Response): Promise<NextResponse> {
  const text = await res.text()

  if (text.trim().length > 0) {
    try {
      JSON.parse(text)
      return new NextResponse(text, {
        status: res.status,
        headers: { 'Content-Type': 'application/json' },
      })
    } catch {
      // fall through to the wrapped-error shape below
    }
  }

  const detail =
    text.trim().length > 0
      ? `Upstream returned a non-JSON response (${res.status}): ${text.slice(0, 300)}`
      : `Upstream returned an empty response (${res.status} ${res.statusText})`
  return NextResponse.json({ detail }, { status: res.ok ? 502 : res.status })
}
