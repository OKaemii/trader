'use client'
import { useState } from 'react'
import { BacktestRunner } from './BacktestRunner'
import { ValidationReports } from './ValidationReports'

export function ResearchView() {
  const [refreshKey, setRefreshKey] = useState(0)
  return (
    <div className="space-y-6">
      <BacktestRunner onComplete={() => setRefreshKey((k) => k + 1)} />
      <ValidationReports refreshKey={refreshKey} />
    </div>
  )
}
