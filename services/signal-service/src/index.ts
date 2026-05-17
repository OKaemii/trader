// Back-compat entry. The real bootstrap lives in main.ts so the Docker CMD can point at
// dist/main.js once Helm references are migrated. Until then `node dist/index.js` re-exports
// keep the existing CMD working.
import "./main.ts";
