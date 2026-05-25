// Lazy-singleton pg pool + small helpers. Mirrors the shape of `@trader/shared-mongo`
// (getMongoClient / getMongoDb) so service code reads similarly across the two stores.
//
// One pool per node process. TIMESCALE_URL is the canonical env; if absent the
// constructor still works for local-dev quick scripts that set PG* env vars
// individually (libpq behaviour — `pg` reads them when no connectionString is given).

import pg from 'pg';

let _pool: pg.Pool | null = null;

export function getPgPool(): pg.Pool {
  if (_pool) return _pool;
  const url = process.env.TIMESCALE_URL ?? '';
  _pool = new pg.Pool(url ? { connectionString: url } : {});
  // Surface unhandled idle-client errors loudly. Default `pg` behaviour is to
  // emit on 'error' and crash if nothing listens; we route to console.error so
  // an idle keep-alive drop doesn't take the process down.
  _pool.on('error', (err) => {
    console.error('[shared-pg] idle client error:', err);
  });
  return _pool;
}

/**
 * One-shot query convenience. `params` is positional (`$1`, `$2`, …); no
 * client-side substitution — bound parameters only, defence against SQL injection
 * via the wire protocol.
 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: ReadonlyArray<unknown>,
): Promise<pg.QueryResult<T>> {
  return getPgPool().query<T>(text, params as unknown[] | undefined);
}

/**
 * Run `fn` inside a transaction. `BEGIN` / `COMMIT` on success; `ROLLBACK` on
 * throw. The client is checked out for the duration of `fn` and released after.
 *
 * Callers receive the per-transaction client — pass it into every nested query
 * so they execute against the same connection (and therefore inside the same
 * transaction). Mongo's `session.withTransaction` has the same shape.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* swallow */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Close the pool. Test cleanup only — production processes hold the pool for
 * their lifetime and let the OS reclaim it on exit.
 */
export async function closePgPool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
