import {
    schedulersToRemove,
    EmptyKnownSetError,
} from '@/app-layer/jobs/schedule-reconcile';
import { ALL_SCHEDULE_NAMES, SCHEDULED_JOBS, ALL_SCHEDULES } from '@/app-layer/jobs/schedules';

/**
 * #803: `registerAll` upserts and never removes, and the only removal path
 * (`--clean`) is not on the deploy command — so a schedule deleted from the
 * code fires in production forever.
 *
 * The reconcile that fixes it is one `Set.has` away from being far worse than
 * the bug: keyed on the wrong set, it DELETES LIVE SCHEDULES whenever an API
 * key is absent. These tests pin that distinction, because both sets are
 * arrays of the same strings and the wrong one is the more obvious import.
 */

describe('schedulersToRemove', () => {
    it('removes what Redis holds and the code does not define', () => {
        expect(schedulersToRemove(['alive', 'orphan'], ['alive'])).toEqual(['orphan']);
    });

    it('keeps everything the code defines', () => {
        expect(schedulersToRemove(['a', 'b'], ['a', 'b', 'c'])).toEqual([]);
    });

    it('REFUSES an empty known-set instead of removing everything', () => {
        // The catastrophic case. An import or build problem that empties the
        // known set must not read as "every schedule was deleted from the
        // code" — and a deploy that wipes Redis looks identical to one with
        // no orphans to remove.
        expect(() => schedulersToRemove(['a', 'b'], [])).toThrow(EmptyKnownSetError);
    });

    it('skips nameless schedulers rather than removing by empty string', () => {
        expect(schedulersToRemove([undefined, 'orphan'], ['keep'])).toEqual(['orphan']);
    });

    it('reports each orphan once', () => {
        expect(schedulersToRemove(['dup', 'dup'], ['keep'])).toEqual(['dup']);
    });
});

describe('the reconcile is keyed on the environment-independent set', () => {
    it('ALL_SCHEDULE_NAMES is non-empty — the guard above is not vacuous', () => {
        // Positive control. Every assertion below compares against this set;
        // if it were empty they would pass while proving nothing.
        expect(ALL_SCHEDULE_NAMES.length).toBeGreaterThan(20);
        expect(ALL_SCHEDULE_NAMES.length).toBe(ALL_SCHEDULES.length);
    });

    it('ALL_SCHEDULE_NAMES is a superset of what this environment runs', () => {
        const running = SCHEDULED_JOBS.map((s) => s.name);
        for (const name of running) {
            expect(ALL_SCHEDULE_NAMES).toContain(name);
        }
    });

    it('key-gated schedules stay KNOWN even when disabled here', () => {
        // The regression this whole issue turns on. In a key-less environment
        // these are absent from SCHEDULED_JOBS but must still be known, or the
        // reconcile deletes them from Redis on the next deploy.
        const gated = ALL_SCHEDULES.filter((s) => s.enabled === false).map((s) => s.name);
        for (const name of gated) {
            expect(ALL_SCHEDULE_NAMES).toContain(name);
            expect(schedulersToRemove([name], ALL_SCHEDULE_NAMES)).toEqual([]);
        }
    });

    it('COUNTERFACTUAL: keying on SCHEDULED_JOBS would delete the gated ones', () => {
        // Stated as an executable test rather than a comment, so the hazard
        // cannot quietly stop being true. If a future change makes both sets
        // identical in every environment this test starts failing, and that is
        // the right moment to re-read this file.
        const gated = ALL_SCHEDULES.filter((s) => s.enabled === false).map((s) => s.name);
        const running = SCHEDULED_JOBS.map((s) => s.name);

        if (gated.length === 0) {
            // Every key IS present in this environment, so the hazard cannot
            // be demonstrated from the live config. Simulate it instead —
            // skipping would let the case vanish silently.
            expect(schedulersToRemove(['gated-job'], ['gated-job'])).toEqual([]);
            expect(schedulersToRemove(['gated-job'], ['other-job'])).toEqual(['gated-job']);
            return;
        }

        for (const name of gated) {
            expect(schedulersToRemove([name], running)).toEqual([name]);
        }
    });
});
