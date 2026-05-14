'use client';
import { useEffect, useState } from 'react';
import type { StrategyOutput } from '@/types/trader';

export function useTopologyStream() {
  const [features, setFeatures] = useState<StrategyOutput | null>(null);

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
      ws = new WebSocket(`${protocol}://${window.location.host}/ws/topology?token=${encodeURIComponent(token)}`);
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
