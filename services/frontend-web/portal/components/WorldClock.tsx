'use client'
import { useEffect, useState } from 'react'

// London and New York sessions in *minutes since UTC midnight* on a regular trading day.
// LSE: 08:00-16:30 local → 08:00-16:30 UTC (BST shifts it; we keep UTC anchors and
// use Intl.DateTimeFormat for the per-timezone display so DST is handled automatically).
// NYSE: 09:30-16:00 ET. We avoid TZ math by formatting via Intl and parsing the result.
//
// Approach: get the current time in each TZ via Intl, then compare against the session
// boundaries in that TZ. Correct under DST without shipping a TZ library.

interface SessionState {
  label: string
  tz: string
  open: { h: number; m: number }
  close: { h: number; m: number }
}

const SESSIONS: SessionState[] = [
  { label: 'LON', tz: 'Europe/London', open: { h: 8,  m: 0 },  close: { h: 16, m: 30 } },
  { label: 'NY',  tz: 'America/New_York', open: { h: 9, m: 30 }, close: { h: 16, m: 0 } },
]

function timeInTz(now: Date, tz: string): { h: number; m: number; weekday: number; display: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  const h = parseInt(get('hour'), 10)
  const m = parseInt(get('minute'), 10)
  // Map weekday short name to 0-6 (Mon..Sun). Saturday/Sunday → no session.
  const wdName = (parts.find((p) => p.type === 'weekday')?.value ?? 'Mon').slice(0, 3)
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(wdName)
  return { h, m, weekday, display: `${get('hour')}:${get('minute')}` }
}

function sessionStatus(now: Date, s: SessionState): { open: boolean; nextLabel: string; nextMs: number } {
  const t = timeInTz(now, s.tz)
  const isWeekend = t.weekday >= 5

  const openMin  = s.open.h  * 60 + s.open.m
  const closeMin = s.close.h * 60 + s.close.m
  const nowMin   = t.h * 60 + t.m
  const isOpen   = !isWeekend && nowMin >= openMin && nowMin < closeMin

  // Compute minutes until next open/close. Approximate (ignores holidays).
  let nextMin: number
  let nextLabel: string
  if (isOpen) {
    nextMin = closeMin - nowMin
    nextLabel = 'closes'
  } else {
    if (isWeekend) {
      // Days until Monday + open offset
      const daysToMon = (7 - t.weekday) % 7 || 1
      nextMin = daysToMon * 24 * 60 - nowMin + openMin
      nextLabel = 'opens'
    } else if (nowMin < openMin) {
      nextMin = openMin - nowMin
      nextLabel = 'opens'
    } else {
      // After close, before next day
      nextMin = (24 * 60 - nowMin) + openMin
      nextLabel = 'opens'
    }
  }
  return { open: isOpen, nextLabel, nextMs: nextMin * 60_000 }
}

function fmtCountdown(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000))
  const d = Math.floor(totalMin / (24 * 60))
  const h = Math.floor((totalMin % (24 * 60)) / 60)
  const m = totalMin % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function WorldClock() {
  const [now, setNow] = useState<Date | null>(null)

  useEffect(() => {
    setNow(new Date())
    const id = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(id)
  }, [])

  // Render nothing during SSR / before hydration to avoid timezone-mismatch warnings.
  if (!now) {
    return <div className="hidden h-6 w-72 md:block" aria-hidden />
  }

  return (
    <div className="hidden items-center gap-3 font-mono text-[11px] text-gray-400 md:flex">
      {SESSIONS.map((s) => {
        const t = timeInTz(now, s.tz)
        const status = sessionStatus(now, s)
        return (
          <div key={s.label} className="flex items-center gap-1.5">
            <span className="text-gray-500">{s.label}</span>
            <span className="text-gray-200">{t.display}</span>
            <span
              className={`rounded px-1 py-0.5 text-[9px] font-semibold uppercase ${
                status.open ? 'bg-emerald-900/60 text-emerald-300' : 'bg-gray-800 text-gray-500'
              }`}
              title={`${status.nextLabel} in ${fmtCountdown(status.nextMs)}`}
            >
              {status.open ? 'open' : 'closed'}
            </span>
          </div>
        )
      })}
    </div>
  )
}
