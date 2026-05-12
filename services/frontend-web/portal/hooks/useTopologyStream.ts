'use client';
import { useEffect, useState } from 'react';
import type { StrategyOutput } from '@/types/trader';

export function useTopologyStream() {
  const [features, setFeatures] = useState<StrategyOutput | null>(null);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws/topology`);
    ws.onmessage = (evt) => {
      try { setFeatures(JSON.parse(evt.data)); } catch {}
    };
    ws.onerror = console.error;
    return () => ws.close();
  }, []);

  return { features };
}
