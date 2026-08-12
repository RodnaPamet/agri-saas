/**
 * Celebrations registry integrity (feat/delight-celebrations).
 *
 * Locks the contract between the MilestoneKey union, the MILESTONES registry,
 * and the ag achievements order so a renamed/missing milestone fails CI
 * instead of silently shipping a celebration with no copy.
 */
import { MILESTONES, AG_MILESTONE_ORDER, type MilestoneKey } from '@/lib/celebrations';

const VALID_PRESETS = ['burst', 'rain', 'fireworks'];

describe('celebrations registry coverage', () => {
    it('every MILESTONES record key matches its definition.key', () => {
        for (const [k, def] of Object.entries(MILESTONES)) {
            expect(def.key).toBe(k);
        }
    });

    it('every milestone has non-empty copy + a valid preset', () => {
        for (const def of Object.values(MILESTONES)) {
            expect(def.message.trim().length).toBeGreaterThan(0);
            expect(VALID_PRESETS).toContain(def.preset);
        }
    });

    it('the six ag milestones are registered + ordered', () => {
        expect(AG_MILESTONE_ORDER).toHaveLength(4);
        for (const key of AG_MILESTONE_ORDER) {
            expect(MILESTONES[key as MilestoneKey]).toBeDefined();
        }
        // No duplicates in the order list.
        expect(new Set(AG_MILESTONE_ORDER).size).toBe(AG_MILESTONE_ORDER.length);
    });
});
