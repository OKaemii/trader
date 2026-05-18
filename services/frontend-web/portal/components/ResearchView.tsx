'use client'
import { useState } from 'react'
import { BacktestRunner } from './BacktestRunner'
import { ValidationReports } from './ValidationReports'

interface ResearchViewProps {
  // SSR-seeded validation reports so the table renders on first paint instead of
  // waiting for client hydration → /portal-api round-trip → admin backtest endpoint.
  initialReports?: Array<Record<string, unknown>> | null
}

export function ResearchView({ initialReports = null }: ResearchViewProps = {}) {
  const [refreshKey, setRefreshKey] = useState(0)
  return (
    <div className="space-y-6">
      <BacktestRunner onComplete={() => setRefreshKey((k) => k + 1)} />
      <ValidationReports refreshKey={refreshKey} initial={initialReports as never} />
    </div>
  )
}
