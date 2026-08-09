/**
 * Pure tests for the command-palette filter-chip helpers.
 *
 * The render side (chip row + active-state styling) is locked
 * by the structural ratchet in `search-palette-migration.test.ts`;
 * here we cover the algebra: empty-set passthrough, multi-select
 * intersection, count derivation, immutability.
 */

import {
    countHitsByKind,
    filterHitsByKind,
    toggleKind,
} from '@/lib/palette/filter';
import type { SearchHit, SearchHitType } from '@/lib/search/types';

function hit(id: string, type: SearchHitType): SearchHit {
    return {
        id,
        type,
        title: `${id}-title`,
        subtitle: null,
        badge: null,
        href: `/x/${id}`,
        score: 0,
        iconKey: 'shield-check',
        category: 'X',
    };
}

const getKind = (h: SearchHit) => h.type;

// ─── filterHitsByKind ─────────────────────────────────────────────────

describe('filterHitsByKind', () => {
    it('passes everything through when active set is empty (no chips selected = all kinds)', () => {
        const hits = [hit('c1', 'control'), hit('a1', 'asset')];
        expect(filterHitsByKind(hits, new Set(), getKind)).toEqual(hits);
    });

    it('keeps only hits whose kind is in the active set', () => {
        const hits = [
            hit('c1', 'control'),
            hit('a1', 'asset'),
            hit('p1', 'policy'),
        ];
        const out = filterHitsByKind(
            hits,
            new Set<SearchHitType>(['control', 'policy']),
            getKind,
        );
        expect(out.map((h) => h.id).sort()).toEqual(['c1', 'p1']);
    });

    it('returns a new array — never mutates input', () => {
        const hits = [hit('c1', 'control'), hit('a1', 'asset')];
        const before = JSON.stringify(hits);
        filterHitsByKind(hits, new Set<SearchHitType>(['control']), getKind);
        expect(JSON.stringify(hits)).toBe(before);
    });

    it('returns an empty array when no hit matches the active set', () => {
        const hits = [hit('c1', 'control')];
        const out = filterHitsByKind(
            hits,
            new Set<SearchHitType>(['asset']),
            getKind,
        );
        expect(out).toEqual([]);
    });
});

// ─── toggleKind ───────────────────────────────────────────────────────

describe('toggleKind', () => {
    it('adds a kind that is not in the active set', () => {
        const out = toggleKind(new Set<SearchHitType>(['control']), 'asset');
        expect([...out].sort()).toEqual(['asset', 'control']);
    });

    it('removes a kind that IS in the active set', () => {
        const out = toggleKind(
            new Set<SearchHitType>(['control', 'asset']),
            'asset',
        );
        expect([...out]).toEqual(['control']);
    });

    it('returns a new Set — never mutates input', () => {
        const input = new Set<SearchHitType>(['control']);
        const before = [...input];
        toggleKind(input, 'asset');
        expect([...input]).toEqual(before);
    });
});

// ─── countHitsByKind ──────────────────────────────────────────────────

describe('countHitsByKind', () => {
    it('zero-fills every kind so callers do not have to defensive-check', () => {
        // The SearchHitType union expanded in #442 to include
        // `asset`, `task`, and `test` (tasks + tests palette
        // entries), then again to add `knowledge` (the knowledge-base
        // articles surfaced in search/palette). The zero-fill must
        // cover every member of the union so callers can index by any
        // literal without a defensive existence check.
        const out = countHitsByKind([], getKind);
        expect(out).toEqual({
            control: 0,
            policy: 0,
            framework: 0,
            evidence: 0,
            asset: 0,
            task: 0,
            knowledge: 0,
        });
    });

    it('counts each hit under its kind', () => {
        const hits = [
            hit('c1', 'control'),
            hit('c2', 'control'),
            hit('a1', 'asset'),
            hit('p1', 'policy'),
        ];
        const out = countHitsByKind(hits, getKind);
        expect(out.control).toBe(2);
        expect(out.asset).toBe(1);
        expect(out.policy).toBe(1);
        expect(out.evidence).toBe(0);
        expect(out.framework).toBe(0);
    });

    it('counts the FULL list — independent of any filter that may be applied later', () => {
        const hits = [hit('c1', 'control'), hit('a1', 'asset')];
        // Even if we then filter to 'control', the count for asset
        // stays at 1 — the chip should still display "Assets (1)" so
        // the user can toggle it back on.
        const out = countHitsByKind(hits, getKind);
        expect(out.asset).toBe(1);
    });
});
