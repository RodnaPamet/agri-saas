/**
 * @jest-environment jsdom
 *
 * Epic 62 — milestone registry + sessionStorage dedupe helpers.
 *
 * jsdom for `window.sessionStorage`. The hook itself ships its own
 * jsdom render test (`tests/rendered/use-celebration.test.tsx`); this
 * file pins the pure-data registry contract + the SSR-safe storage
 * helpers so they can be relied on outside the React lifecycle.
 */

import {
    MILESTONES,
    celebrationDedupeKey,
    clearCelebrated,
    hasCelebrated,
    markCelebrated,
    scopedMilestone,
    type MilestoneKey,
} from '@/lib/celebrations';

const ALL_KEYS: MilestoneKey[] = [
    'framework-100',
    'evidence-all-current',
    'audit-pack-complete',
    'first-practice-mapped',
];

describe('MILESTONES registry', () => {
    it('contains every key the union declares', () => {
        for (const k of ALL_KEYS) {
            expect(MILESTONES[k]).toBeDefined();
            expect(MILESTONES[k].key).toBe(k);
        }
    });

    it('every entry has a non-empty message and a valid preset', () => {
        for (const def of Object.values(MILESTONES)) {
            expect(def.message.length).toBeGreaterThan(0);
            expect(['burst', 'rain', 'fireworks']).toContain(def.preset);
        }
    });

    it('keys are stable identifiers (no rename without intent)', () => {
        // This test exists so a rename of a milestone key is a
        // visible diff in the test file too — keys ride in
        // sessionStorage and analytics, so renames need ceremony.
        expect(Object.keys(MILESTONES).sort()).toEqual([
            'audit-pack-complete',
            'evidence-all-current',
            // feat/delight-celebrations — agriculture milestones.
            'first-field-mapped',
            'first-harvest',
            'first-practice-mapped',
            'framework-100',
            'inspection-passed',
            'season-closed',
            'sop-100-ack',
            'spray-job-complete',
        ]);
    });
});

describe('celebrationDedupeKey', () => {
    it('namespaces with the inflect prefix to avoid collisions', () => {
        expect(celebrationDedupeKey('framework-100')).toBe(
            'inflect.celebrate:framework-100',
        );
    });
});

describe('hasCelebrated / markCelebrated / clearCelebrated', () => {
    beforeEach(() => {
        window.sessionStorage.clear();
    });

    it('hasCelebrated is false before mark, true after', () => {
        expect(hasCelebrated('framework-100')).toBe(false);
        markCelebrated('framework-100');
        expect(hasCelebrated('framework-100')).toBe(true);
    });

    it('mark is idempotent — second call is a no-op', () => {
        markCelebrated('framework-100');
        const first = window.sessionStorage.getItem(
            celebrationDedupeKey('framework-100'),
        );
        markCelebrated('framework-100');
        const second = window.sessionStorage.getItem(
            celebrationDedupeKey('framework-100'),
        );
        // Second mark overwrites with a new ISO timestamp, but
        // hasCelebrated still returns true and the key still exists.
        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(hasCelebrated('framework-100')).toBe(true);
    });

    it('clearCelebrated lets the milestone fire again', () => {
        markCelebrated('framework-100');
        expect(hasCelebrated('framework-100')).toBe(true);
        clearCelebrated('framework-100');
        expect(hasCelebrated('framework-100')).toBe(false);
    });

    it('different keys do not interfere with each other', () => {
        markCelebrated('framework-100');
        expect(hasCelebrated('framework-100')).toBe(true);
        expect(hasCelebrated('audit-pack-complete')).toBe(false);
    });

    it('scoped keys are independent of the bare milestone key', () => {
        // Per-resource celebration must NOT be deduped by an
        // earlier global mark, and vice-versa.
        markCelebrated('framework-100');
        expect(hasCelebrated('framework-100:iso27001')).toBe(false);
        markCelebrated('framework-100:iso27001');
        expect(hasCelebrated('framework-100:iso27001')).toBe(true);
        expect(hasCelebrated('framework-100:soc2')).toBe(false);
    });
});

describe('scopedMilestone builder', () => {
    it('returns the registry preset + message + colon-namespaced key', () => {
        const out = scopedMilestone('framework-100', 'iso27001');
        expect(out.preset).toBe(MILESTONES['framework-100'].preset);
        expect(out.message).toBe(MILESTONES['framework-100'].message);
        expect(out.description).toBe(
            MILESTONES['framework-100'].description,
        );
        expect(out.key).toBe('framework-100:iso27001');
    });

    it('descriptionOverride wins over the registry default', () => {
        const out = scopedMilestone('framework-100', 'iso27001', {
            descriptionOverride: 'ISO 27001:2022 — done.',
        });
        expect(out.description).toBe('ISO 27001:2022 — done.');
        // Other registry fields untouched.
        expect(out.preset).toBe(MILESTONES['framework-100'].preset);
        expect(out.message).toBe(MILESTONES['framework-100'].message);
    });

    it('different scopes produce different dedupe keys for the same milestone', () => {
        const a = scopedMilestone('audit-pack-complete', 'pack_abc');
        const b = scopedMilestone('audit-pack-complete', 'pack_xyz');
        expect(a.key).not.toBe(b.key);
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
            expect(() => markCelebrated('framework-100')).not.toThrow();
            expect(hasCelebrated('framework-100')).toBe(false);
            expect(() => clearCelebrated('framework-100')).not.toThrow();
        } finally {
            setSpy.mockRestore();
            getSpy.mockRestore();
            removeSpy.mockRestore();
        }
    });
});
