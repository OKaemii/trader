// Research-notebook domain (Task 33 §G, locked decision #7). A per-entity markdown note plus the
// `@`-links parsed out of its body, which drive a backlink index ("notes referencing entity X").
//
// This file is PURE — no Mongo, no Hono — so the @-link grammar is unit-testable in isolation and
// the route/store stay thin. The Mongo store (infrastructure/MongoResearchNotesStore.ts) persists
// these shapes verbatim into COLLECTIONS.RESEARCH_NOTES; the doc-shape contract is owned by Task 5
// (#58 release notes) — { _id, body, links, updatedBy, updatedAt }.

/** The three kinds of entity a note can reference. Matches the doc-shape contract from card #58. */
export type ResearchLinkKind = 'strategy' | 'signal' | 'symbol';

export const RESEARCH_LINK_KINDS: readonly ResearchLinkKind[] = ['strategy', 'signal', 'symbol'];

/** One parsed `@`-mention. `ref` is the referenced entity's id/ticker (kind-specific). */
export interface ResearchLink {
    kind: ResearchLinkKind;
    ref: string;
}

/** A research note as stored + served. `ticker` is the doc `_id` (the entity the note is ABOUT). */
export interface ResearchNote {
    ticker: string;
    body: string;
    links: ResearchLink[];
    updatedBy: string | null;
    updatedAt: number | null;
}

// @-link grammar (locked decision #7 — "@-links to strategies / signals / symbols"):
//
//   @<kind>:<ref>
//
// where <kind> ∈ {strategy, signal, symbol} and <ref> is one token of [A-Za-z0-9_-] (covers tickers
// like AAPL_US_EQ / BPl_EQ, strategy ids like factor_rank_v1, and signal ObjectId hex / ULID refs).
// `.` is deliberately EXCLUDED from the ref alphabet so a sentence-ending period (`…@signal:abc.`)
// terminates the ref instead of being swallowed — none of the three id schemes contain a dot. The
// leading `@` must be at a word boundary (start-of-string or preceded by whitespace/markdown
// punctuation) so an email address (a@b.com) or a code identifier (foo@bar) is NOT mis-parsed as a
// mention. The kind keyword is matched literally; an unknown kind keyword simply doesn't match (no
// link emitted) — we never invent a 4th kind.
//
// The `(?<=^|[\s([{<>"'`*_~,/])` lookbehind anchors the boundary; `:` separates kind from ref.
const LINK_RE = /(?<=^|[\s([{<>"'`*_~,/])@(strategy|signal|symbol):([A-Za-z0-9_-]+)/g;

/**
 * Parse the `@`-mentions out of a markdown body into a deduped, deterministically-ordered link list.
 *
 * - Dedup is by `(kind, ref)` — the same mention twice yields one link.
 * - `symbol` refs are upper-cased (tickers are case-insensitive at the boundary; this keeps the
 *   backlink index from splitting `@symbol:aapl` and `@symbol:AAPL`). `strategy`/`signal` refs are
 *   kept verbatim (ids are case-sensitive).
 * - Order is FIRST-APPEARANCE in the body (stable, so the saved doc round-trips identically and a
 *   re-save with no edits is a no-op diff).
 */
export function parseLinks(body: string): ResearchLink[] {
    const seen = new Set<string>();
    const out: ResearchLink[] = [];
    // Reset lastIndex defensively (LINK_RE is module-level + /g, so exec/matchAll share it).
    LINK_RE.lastIndex = 0;
    for (const m of body.matchAll(LINK_RE)) {
        const kind = m[1] as ResearchLinkKind;
        const ref = kind === 'symbol' ? m[2]!.toUpperCase() : m[2]!;
        const key = `${kind}:${ref}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind, ref });
    }
    return out;
}

/** True iff `s` is one of the three valid link kinds — used to validate a backlinks query param. */
export function isResearchLinkKind(s: string): s is ResearchLinkKind {
    return (RESEARCH_LINK_KINDS as readonly string[]).includes(s);
}

/**
 * Normalise a backlinks `ref` query param the SAME way parseLinks normalises stored refs, so a
 * lookup of `?kind=symbol&ref=aapl` finds notes that wrote `@symbol:AAPL`. Mirror of the casing
 * rule above — symbol upper-cased, strategy/signal verbatim.
 */
export function normaliseRef(kind: ResearchLinkKind, ref: string): string {
    return kind === 'symbol' ? ref.toUpperCase() : ref;
}
