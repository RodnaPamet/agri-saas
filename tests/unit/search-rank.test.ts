/**
 * Pure tests for the unified-search ranking helpers.
 *
 * The score table is the contract: clients can ignore exact
 * magnitudes (they consume score-DESC ordering only), but the
 * relative bands MUST keep their pecking order — exact > prefix
 * > title-substring > subtitle-substring — or the palette starts
 * surfacing weak matches before strong ones.
 */

import {
    capPerType,
    computeRankScore,
    sortHits,
} from '@/lib/search/rank';
import type { SearchHit } from '@/lib/search/types';

// ─── computeRankScore ─────────────────────────────────────────────────

describe('computeRankScore — match bands', () => {
    it('exact title match outranks prefix match', () => {
        const exact = computeRankScore('phishing', { type: 'asset', title: 'phishing' });
        const prefix = computeRankScore('phish', { type: 'asset', title: 'phishing' });
        expect(exact).toBeGreaterThan(prefix);
    });

    it('exact code match outranks substring title match', () => {
        const exactCode = computeRankScore('a.5.1', {
            type: 'control',
            title: 'Information security policies',
            code: 'A.5.1',
        });
        const substr = computeRankScore('information', {
            type: 'control',
            title: 'Information security policies',
        });
        expect(exactCode).toBeGreaterThan(substr);
    });

    it('prefix match outranks substring title match', () => {
        const prefix = computeRankScore('inf', { type: 'control', title: 'Information' });
        const substr = computeRankScore('orma', { type: 'control', title: 'Information' });
        expect(prefix).toBeGreaterThan(substr);
    });

    it('title substring outranks subtitle-only substring', () => {
        const titleHit = computeRankScore('access', { type: 'asset', title: 'Unauthorised access' });
        const subtitleHit = computeRankScore('access', {
            type: 'asset',
            title: 'Phishing',
            subtitle: 'Access category',
        });
        expect(titleHit).toBeGreaterThan(subtitleHit);
    });

    it('case-insensitive matching', () => {
        const upper = computeRankScore('PHISH', { type: 'asset', title: 'phishing' });
        const lower = computeRankScore('phish', { type: 'asset', title: 'phishing' });
        expect(upper).toBe(lower);
    });

    it('returns 0 for empty query', () => {
        expect(computeRankScore('', { type: 'asset', title: 'anything' })).toBe(0);
        expect(computeRankScore('   ', { type: 'asset', title: 'anything' })).toBe(0);
    });

    it('returns only the type-baseline when no field matches', () => {
        const score = computeRankScore('zzz', { type: 'control', title: 'anything' });
        // No match band fires; only the per-type baseline (control = 4).
        expect(score).toBeGreaterThan(0);
        expect(score).toBeLessThan(10);
    });

    it('control type gets a higher baseline than evidence', () => {
        const c = computeRankScore('zzz', { type: 'control', title: 'anything' });
        const e = computeRankScore('zzz', { type: 'evidence', title: 'anything' });
        expect(c).toBeGreaterThan(e);
    });

    it('type baseline cannot promote a weak match over a strong one', () => {
        // Substring on title (30 + control_baseline=4) should NOT
        // outrank an exact match on evidence (100 + evidence_baseline=0).
        const weakControl = computeRankScore('orma', {
            type: 'control',
            title: 'Information',
        });
        const strongEvidence = computeRankScore('logs', {
            type: 'evidence',
            title: 'logs',
        });
        expect(strongEvidence).toBeGreaterThan(weakControl);
    });
});

// ─── sortHits ─────────────────────────────────────────────────────────

function hit(
    id: string,
    type: SearchHit['type'],
    score: number,
    overrides: Partial<SearchHit> = {},
): SearchHit {
    return {
        id,
        type,
        title: id,
        subtitle: null,
        badge: null,
        href: `/x/${id}`,
        score,
        iconKey: 'shield-check',
        category: 'X',
        ...overrides,
    };
}

describe('sortHits', () => {
    it('orders by score DESC', () => {
        const out = sortHits([hit('a', 'control', 10), hit('b', 'control', 50), hit('c', 'control', 30)]);
        expect(out.map((h) => h.id)).toEqual(['b', 'c', 'a']);
    });

    it('breaks ties by type baseline (control > evidence)', () => {
        const out = sortHits([hit('e1', 'evidence', 30), hit('c1', 'control', 30)]);
        expect(out.map((h) => h.id)).toEqual(['c1', 'e1']);
    });

    it('breaks remaining ties by id ASC (deterministic)', () => {
        const out = sortHits([
            hit('z', 'control', 30),
            hit('a', 'control', 30),
            hit('m', 'control', 30),
        ]);
        expect(out.map((h) => h.id)).toEqual(['a', 'm', 'z']);
    });
});

// ─── capPerType ────────────────────────────────────────────────────────

describe('capPerType', () => {
    it('keeps everything when under the cap', () => {
        const out = capPerType([hit('c1', 'control', 50), hit('r1', 'asset', 40)], 5);
        expect(out.kept).toHaveLength(2);
        expect(out.truncated).toBe(false);
        expect(out.perTypeCounts.control).toBe(1);
        expect(out.perTypeCounts.asset).toBe(1);
    });

    it('caps each type independently and flags truncated', () => {
        const hits = [
            hit('c1', 'control', 50),
            hit('c2', 'control', 49),
            hit('c3', 'control', 48),
            hit('r1', 'asset', 40),
        ];
        const out = capPerType(hits, 2);
        expect(out.kept.map((h) => h.id)).toEqual(['c1', 'c2', 'r1']);
        expect(out.perTypeCounts.control).toBe(2);
        expect(out.perTypeCounts.asset).toBe(1);
        expect(out.truncated).toBe(true);
    });

    it('zero-fills perTypeCounts so callers do not have to defensively check', () => {
        const out = capPerType([], 5);
        expect(out.perTypeCounts).toEqual({
            control: 0,
            policy: 0,
            framework: 0,
            evidence: 0,
            asset: 0,
            task: 0,
            knowledge: 0,
        });
        expect(out.truncated).toBe(false);
    });

    it('respects the input order — caller must pre-sort by score', () => {
        // First-in, first-kept until cap. Demonstrates the
        // "sort then cap" contract.
        const out = capPerType([hit('low', 'control', 10), hit('high', 'control', 90)], 1);
        expect(out.kept.map((h) => h.id)).toEqual(['low']);
    });
});
