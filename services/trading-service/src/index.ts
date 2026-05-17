// Back-compat: existing tests import `buildApp` from this path. Production runs via main.ts.
export { buildApp, type AppDeps } from "./routes.ts";

// Trigger production bootstrap when this file is loaded as the entrypoint
// (Docker CMD: `node dist/index.js`). main.ts has its own .catch + exit.
import "./main.ts";
