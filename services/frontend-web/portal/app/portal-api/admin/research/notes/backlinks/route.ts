import { NextResponse, type NextRequest } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Thin proxy → signal-service research module GET /admin/api/research/notes/backlinks?kind=&ref=
// ("notes referencing entity X"; T33 §G). Returns { kind, ref, notes: [{ ticker, body, links,
// updatedBy, updatedAt }, …] } newest-first. `kind` ∈ strategy|signal|symbol; `ref` is the entity
// id/ticker. The static `backlinks` segment takes precedence over the sibling [ticker] route, so a
// note literally named "backlinks" is unreachable by design (it isn't a valid ticker anyway).
export async function GET(req: NextRequest) {
  const kind = req.nextUrl.searchParams.get('kind') ?? ''
  const ref = req.nextUrl.searchParams.get('ref') ?? ''
  const qs = new URLSearchParams({ kind, ref }).toString()
  const upstream = await authedFetch(`/admin/api/research/notes/backlinks?${qs}`)
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
