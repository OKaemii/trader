// One-shot migration entrypoint, invoked by the timescale-init Helm hook job
// (infra/helm/trader/templates/timescale-init-job.yaml).
//
// Compiles to dist/migrate.js. Container command in the Helm job overrides the
// service's normal CMD to run `node services/market-data-service/dist/migrate.js`
// so the same image serves both purposes.
//
// Retry on connection failure for ~30s — Timescale may still be coming up when
// the trader-app post-install hook fires. Each migration file is idempotent
// (already-applied files are skipped via schema_migrations), so a re-run after a
// partial success is safe.

import { runMigrations, closePgPool } from '@trader/shared-pg';

const MAX_ATTEMPTS = 15;
const RETRY_DELAY_MS = 2_000;

async function main(): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await runMigrations();
      console.log(
        `[migrate] applied=${result.applied.length} skipped=${result.skipped.length}`,
      );
      if (result.applied.length > 0) {
        console.log('[migrate] applied files:', result.applied.join(', '));
      }
      await closePgPool();
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === MAX_ATTEMPTS) {
        console.error(`[migrate] giving up after ${attempt} attempts:`, err);
        await closePgPool().catch(() => undefined);
        process.exit(1);
      }
      // Connection-shaped errors only — schema errors should fail loud, not retry.
      // The pg error code 'ECONNREFUSED' / '57P03' (cannot_connect_now) / '08006'
      // (connection_failure) all indicate the DB isn't ready yet.
      const isConnectionError = /ECONNREFUSED|57P03|08006|ETIMEDOUT|ENOTFOUND/.test(msg);
      if (!isConnectionError) {
        console.error('[migrate] non-connection error, failing fast:', err);
        await closePgPool().catch(() => undefined);
        process.exit(1);
      }
      console.warn(
        `[migrate] attempt ${attempt}/${MAX_ATTEMPTS} failed (DB not ready?), retrying in ${RETRY_DELAY_MS}ms: ${msg}`,
      );
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
}

main().catch((err) => {
  console.error('[migrate] fatal:', err);
  process.exit(1);
});
