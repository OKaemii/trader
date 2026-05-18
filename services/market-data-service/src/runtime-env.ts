// Module-local cache of the parsed env. main.ts calls setRuntimeEnv(env) at boot so
// the bulk of src/ reads validated values without touching process.env directly.
//
// Lazy fallback: if setRuntimeEnv() hasn't been called by the time something reads the
// env (typically a Vitest run that imports index.ts directly without going through
// main.ts), we parse process.env once here. Production never hits this path because
// main.ts always wires first; the fallback keeps tests from having to know about boot
// order.

import { loadMarketDataEnv, type MarketDataEnv } from "./env.ts";

let _env: MarketDataEnv | null = null;

export function setRuntimeEnv(env: MarketDataEnv): void {
    _env = env;
}

export function getRuntimeEnv(): MarketDataEnv {
    if (!_env) _env = loadMarketDataEnv();
    return _env;
}
