/**
 * @jest-environment jsdom
 *
 * Epic 62 — milestone registry + sessionStorage dedupe helpers.
 *
 * jsdom for `window.sessionStorage`. The hook itself ships its own
 * jsdom render test (`tests/rendered/use-celebration.test.tsx`); this
 * file pins the pure-data registry contract + the SSR-safe storage
 * helpers so they can be relied on outside the React lifecycle.
 *
 * P2.6 moved the toast COPY out of the registry into
 * `messages/{bg,en}.json` (`celebrations.*`), so the assertions here are
 * about `preset` + `glyph` + the key set. The copy itself is pinned by
 * `tests/guards/celebrations-coverage.test.ts` (both catalogues carry
 * every milestone's two strings) and exercised end to end by
 * `tests/rendered/use-celebration.test.tsx`.
 */

import {
    MILESTONES,
    celebrationDedupeKey,
    clearCelebrated,
    hasCelebrated,
    markCelebrated,
    type MilestoneKey,
} from '@/lib/celebrations';

const ALL_KEYS: MilestoneKey[] = [
    'evidence-all-current',
    'first-field-mapped',
    'spray-job-complete',
    'first-harvest',
    'season-closed',
];

describe('MILESTONES registry', () => {
    it('contains every key the union declares', () => {
        for (const k of ALL_KEYS) {
            expect(MILESTONES[k]).toBeDefined();
            expect(MILESTONES[k].key).toBe(k);
        }
    });

    it('every entry has a glyph and a valid preset', () => {
        for (const def of Object.values(MILESTONES)) {
            expect(def.glyph.length).toBeGreaterThan(0);
            expect(['burst', 'rain', 'fireworks']).toContain(def.preset);
        }
    });

    it('carries NO copy — the catalogue owns it', () => {
        // The regression this guards is the easy one to reintroduce: a
        // contributor adding `message:` back to a record, which would then
        // ship English to a Bulgarian farmer and be invisible to the
        // hard-coded-string ratchet (it scans src/app + src/components only).
        for (const def of Object.values(MILESTONES)) {
            expect(def).not.toHaveProperty('message');
            expect(def).not.toHaveProperty('description');
        }
    });

    it('keys are stable identifiers (no rename without intent)', () => {
        // This test exists so a rename of a milestone key is a
        // visible diff in the test file too — keys ride in
        // sessionStorage and analytics, so renames need ceremony.
        expect(Object.keys(MILESTONES).sort()).toEqual([
            'evidence-all-current',
            // feat/delight-celebrations — agriculture milestones.
            'first-field-mapped',
            'first-harvest',
            // GRC teardown phase 2 removed 'inspection-passed' + 'sop-100-ack'
            // with their AuditPack / Policy data sources (plan §1c); P2.6
            // removed 'framework-100', 'audit-pack-complete' and
            // 'first-practice-mapped' for the same reason — the models were
            // gone, no caller fired them, and their copy was about to be
            // translated into Bulgarian.
            'season-closed',
            'spray-job-complete',
        ]);
    });
});

describe('celebrationDedupeKey', () => {
    it('namespaces with the inflect prefix to avoid collisions', () => {
        // The prefix is an INTENTIONAL legacy-brand survivor — see
        // tests/guards/no-legacy-brand.test.ts. Renaming it re-fires every
        // celebration for everyone with a warm tab.
        expect(celebrationDedupeKey('first-harvest')).toBe(
            'inflect.celebrate:first-harvest',
        );
    });
});

describe('hasCelebrated / markCelebrated / clearCelebrated', () => {
    beforeEach(() => {
        window.sessionStorage.clear();
    });

    it('hasCelebrated is false before mark, true after', () => {
        expect(hasCelebrated('first-harvest')).toBe(false);
        markCelebrated('first-harvest');
        expect(hasCelebrated('first-harvest')).toBe(true);
    });

    it('mark is idempotent — second call is a no-op', () => {
        markCelebrated('first-harvest');
        const first = window.sessionStorage.getItem(
            celebrationDedupeKey('first-harvest'),
        );
        markCelebrated('first-harvest');
        const second = window.sessionStorage.getItem(
            celebrationDedupeKey('first-harvest'),
        );
        // Second mark overwrites with a new ISO timestamp, but
        // hasCelebrated still returns true and the key still exists.
        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(hasCelebrated('first-harvest')).toBe(true);
    });

    it('clearCelebrated lets the milestone fire again', () => {
        markCelebrated('first-harvest');
        expect(hasCelebrated('first-harvest')).toBe(true);
        clearCelebrated('first-harvest');
        expect(hasCelebrated('first-harvest')).toBe(false);
    });

    it('different keys do not interfere with each other', () => {
        markCelebrated('first-harvest');
        expect(hasCelebrated('first-harvest')).toBe(true);
        expect(hasCelebrated('season-closed')).toBe(false);
    });

    it('scoped keys are independent of the bare milestone key', () => {
        // Per-resource celebration must NOT be deduped by an
        // earlier global mark, and vice-versa. The `scopedMilestone`
        // helper that built these keys went with the GRC resources it
        // was written for (P2.6); the colon CONVENTION it established is
        // still what an ad-hoc per-resource caller must use, so the
        // storage behaviour stays pinned here.
        markCelebrated('spray-job-complete');
        expect(hasCelebrated('spray-job-complete:job_abc')).toBe(false);
        markCelebrated('spray-job-complete:job_abc');
        expect(hasCelebrated('spray-job-complete:job_abc')).toBe(true);
        expect(hasCelebrated('spray-job-complete:job_xyz')).toBe(false);
    });

    it('survives sessionStorage throwing (private mode) without crashing', () => {
        // Spy on the prototype so the override reaches the helpers'
        // call sites — jsdom's Storage methods live on the prototype
        // and direct instance assignment doesn't always shadow them.
        const setSpy = jest
            .spyOn(Storage.prototype, 'setItem')
            .mockImplementation(() => {
                throw new Error('quota');
            });
        const getSpy = jest
            .spyOn(Storage.prototype, 'getItem')
            .mockImplementation(() => {
                throw new Error('disabled');
            });
        const removeSpy = jest
            .spyOn(Storage.prototype, 'removeItem')
            .mockImplementation(() => {
                throw new Error('disabled');
            });
        try {
            // None of these may throw.
            expect(() => markCelebrated('first-harvest')).not.toThrow();
            expect(hasCelebrated('first-harvest')).toBe(false);
            expect(() => clearCelebrated('first-harvest')).not.toThrow();
        } finally {
            setSpy.mockRestore();
            getSpy.mockRestore();
            removeSpy.mockRestore();
        }
    });
});
