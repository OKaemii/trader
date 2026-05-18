'use client';
import { useEffect, useState } from 'react';
import type { StrategyOutput } from '@/types/trader';

// Initial snapshot is SSR-fetched via /admin/api/signals/topology/snapshot and passed
// down so consumers (FactorExposureChart, RegimeWidget, BettiCurveChart) render real
// data on first paint. Without this seed, the page sits in skeleton state for up to
// 15 minutes — until the next strategy cycle publishes via the WebSocket pubsub.
export function useTopologyStream(initial: StrategyOutput | null = null) {
  const [features, setFeatures] = useState<StrategyOutput | null>(initial);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let cancelled = false;

    async function connect() {
      let token: string;
      try {
        const res = await fetch('/portal-api/auth/ws-token');
        if (!res.ok) return;
        ({ token } = await res.json());
      } catch {
        return;
      }

      if (cancelled) return;

      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${protocol}://${window.location.host}/ws/api/signals/topology?token=${encodeURIComponent(token)}`);
      ws.onmessage = (evt) => {
        try { setFeatures(JSON.parse(evt.data)); } catch {}
      };
      ws.onerror = console.error;
    }

    connect();
    return () => {
      cancelled = true;
      ws?.close();
    };
  }, []);

  return { features };
}
