import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Portal test harness. Default env is `node` (pure modules: command-registry,
// learning-content, tab-fallback helpers — the bulk of the IA-redesign unit tests).
// Component tests opt into a DOM per-file with a docblock pragma:
//   // @vitest-environment happy-dom
// The react() plugin is wired so those component tests can render JSX with hooks.
export default defineConfig({
  plugins: [react()],
  // Mirror tsconfig's `@/*` → repo-root path mapping so component tests can render
  // components that import via the `@/` alias (the codebase convention — e.g.
  // CommandPalette → @/app/actions/auth). Pure-module tests still use relative
  // imports; this only adds, never overrides, resolution.
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules/**', '.next/**'],
  },
})
