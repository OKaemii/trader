// Dependency-free className joiner for the ui/* primitives. Lets a caller layer
// its own Tailwind classes onto a wrapper's dark-theme defaults (later classes win
// only by source order — these primitives put the base first, the caller's last).
// Intentionally tiny: we don't pull clsx/tailwind-merge for a join this simple.
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
