// Unit tests for the pure @-link parser (T33 §G). Pins the grammar the backlink index relies on:
// kind ∈ {strategy,signal,symbol}, word-boundary anchoring, dedup, and the symbol upper-casing rule.

import { describe, it, expect } from 'vitest';
import {
    parseLinks,
    isResearchLinkKind,
    normaliseRef,
    RESEARCH_LINK_KINDS,
} from '../modules/research/application/ResearchNotes.ts';

describe('parseLinks', () => {
    it('parses one @-mention of each kind', () => {
        const body = 'Watching @symbol:AAPL_US_EQ under @strategy:factor_rank_v1 — see @signal:abc123.';
        expect(parseLinks(body)).toEqual([
            { kind: 'symbol', ref: 'AAPL_US_EQ' },
            { kind: 'strategy', ref: 'factor_rank_v1' },
            { kind: 'signal', ref: 'abc123' },
        ]);
    });

    it('returns [] for a body with no mentions', () => {
        expect(parseLinks('Just a plain note with no links at all.')).toEqual([]);
        expect(parseLinks('')).toEqual([]);
    });

    it('dedupes repeated (kind, ref) pairs, keeping first-appearance order', () => {
        const body = '@strategy:s1 then @symbol:AAPL then @strategy:s1 again and @symbol:AAPL again';
        expect(parseLinks(body)).toEqual([
            { kind: 'strategy', ref: 's1' },
            { kind: 'symbol', ref: 'AAPL' },
        ]);
    });

    it('upper-cases symbol refs but keeps strategy/signal refs verbatim', () => {
        const body = '@symbol:aapl @strategy:Factor_Rank_V1 @signal:AbC';
        expect(parseLinks(body)).toEqual([
            { kind: 'symbol', ref: 'AAPL' },
            { kind: 'strategy', ref: 'Factor_Rank_V1' },
            { kind: 'signal', ref: 'AbC' },
        ]);
    });

    it('folds @symbol:aapl and @symbol:AAPL into one link (case-insensitive symbols)', () => {
        expect(parseLinks('@symbol:aapl and @symbol:AAPL')).toEqual([{ kind: 'symbol', ref: 'AAPL' }]);
    });

    it('does NOT treat an email address as a mention (word-boundary anchor)', () => {
        // `strategy@example.com` — the @ is preceded by a word char, so it is not a boundary.
        expect(parseLinks('Reach me at ops@example.com about @strategy:s1')).toEqual([
            { kind: 'strategy', ref: 's1' },
        ]);
    });

    it('does NOT match an unknown kind keyword', () => {
        expect(parseLinks('@portfolio:p1 @sector:tech @strategy:s1')).toEqual([
            { kind: 'strategy', ref: 's1' },
        ]);
    });

    it('matches a mention at the very start of the body', () => {
        expect(parseLinks('@symbol:MSFT leads')).toEqual([{ kind: 'symbol', ref: 'MSFT' }]);
    });

    it('matches mentions wrapped in markdown punctuation (parens, brackets, emphasis)', () => {
        const body = '(@symbol:GOOG) [@strategy:s1] **@signal:x1**';
        expect(parseLinks(body)).toEqual([
            { kind: 'symbol', ref: 'GOOG' },
            { kind: 'strategy', ref: 's1' },
            { kind: 'signal', ref: 'x1' },
        ]);
    });

    it('stops the ref at the first non-ref char (whitespace / punctuation outside the ref alphabet)', () => {
        // A trailing period is not part of the ref; a `:` after the ref token also terminates it.
        expect(parseLinks('Hold @symbol:BPl_EQ, then sell.')).toEqual([{ kind: 'symbol', ref: 'BPL_EQ' }]);
        expect(parseLinks('@strategy:high_velocity_v1: monthly')).toEqual([
            { kind: 'strategy', ref: 'high_velocity_v1' },
        ]);
    });
});

describe('isResearchLinkKind', () => {
    it('accepts the three valid kinds and nothing else', () => {
        for (const k of RESEARCH_LINK_KINDS) expect(isResearchLinkKind(k)).toBe(true);
        expect(isResearchLinkKind('portfolio')).toBe(false);
        expect(isResearchLinkKind('')).toBe(false);
        expect(isResearchLinkKind('Strategy')).toBe(false); // case-sensitive
    });
});

describe('normaliseRef', () => {
    it('upper-cases symbol refs and leaves strategy/signal refs verbatim — mirroring parseLinks', () => {
        expect(normaliseRef('symbol', 'aapl_us_eq')).toBe('AAPL_US_EQ');
        expect(normaliseRef('strategy', 'Factor_Rank_V1')).toBe('Factor_Rank_V1');
        expect(normaliseRef('signal', 'AbC')).toBe('AbC');
    });
});
