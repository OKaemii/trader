'use client';
import { useEffect, useState } from 'react';

interface ServiceHealth {
  name: string;
  ok: boolean;
  status?: number;
}

export function StrategyHealthBanner() {
  const [services, setServices] = useState<ServiceHealth[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const poll = () => {
      fetch('/portal-api/admin/system/health')
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((data: ServiceHealth[]) => { setServices(data); setLoading(false); })
        .catch(() => setLoading(false));
    };
    poll();
    const id = setInterval(poll, 60_000);
    return () => clearInterval(id);
  }, []);

  if (loading || services.length === 0) return null;

  const degraded = services.filter((s) => !s.ok);
  if (degraded.length === 0) return null;

  return (
    <div className="col-span-2 flex items-center gap-2 rounded-lg border border-red-700 bg-red-950 px-4 py-3">
      <span className="text-red-400 font-semibold text-sm">Strategy degraded:</span>
      <span className="text-red-300 text-sm">
        {degraded.map((s) => s.name).join(', ')} {degraded.length === 1 ? 'is' : 'are'} unhealthy.
        Signals may be paused.
      </span>
    </div>
  );
}
