/**
 * `featureFlagsCapability` — #2009 option 1's production half.
 *
 * Executing, not structural. The thing worth testing is the MAPPING from a row
 * set to a verdict: #2291's whole finding was that a plausible-looking check
 * got the population wrong, so a guard asserting this function is wired would
 * prove nothing about what it answers.
 *
 * Each case passes a fake reader rather than a database, because the question
 * is arithmetic over two sets and the one risk worth covering — an unreadable
 * table reporting a configuration fault — is easier to provoke by throwing
 * than by breaking Postgres.
 */
import {
    featureFlagsCapability,
    type FeatureFlagKeyReader,
} from '@/lib/feature-flags-capability';
import { DELIBERATELY_ROWLESS_FLAG_KEYS, REFERENCED_FLAG_KEYS } from '@/lib/feature-flag-keys';

jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

const reader = (keys: string[]): FeatureFlagKeyReader => ({
    featureFlag: { findMany: async () => keys.map((key) => ({ key })) },
});

const throwing = (): FeatureFlagKeyReader => ({
    featureFlag: {
        findMany: async () => {
            throw new Error('connection terminated unexpectedly');
        },
    },
});

describe('featureFlagsCapability (#2009)', () => {
    it('every referenced key has a row → complete', () => {
        // The positive control. Without it, every "incomplete" case below is
        // satisfied by a function that returns `incomplete` unconditionally.
        return expect(featureFlagsCapability(reader([...REFERENCED_FLAG_KEYS]))).resolves.toEqual({
            state: 'complete',
            missingRows: [],
            dormantRows: [],
            // Every key has a row in this fixture, so the two
            // deliberately-rowless entries have outlived their decision —
            // which is exactly what `staleDormantEntries` reports (#2841).
            staleDormantEntries: [...DELIBERATELY_ROWLESS_FLAG_KEYS].sort(),
            referenced: REFERENCED_FLAG_KEYS.length,
            orphanRows: 0,
        });
    });

    it('reproduces the 2026-10-24 production state, and names both keys', async () => {
        // The exact table #2291 measured: four rows, two referenced keys with
        // none. `social.farm-media` is the one that mattered — with
        // `social.public-profile` present, the public page rendered while every
        // photograph 404'd.
        //
        // ## Scoped to the keys that existed THEN, deliberately (#2421)
        //
        // This asserted `missingRows` with exact equality against the whole
        // current registry, so adding any new referenced key broke it — which
        // it did the moment `agro.orthophoto` was registered. Neither obvious
        // repair is right: putting the new key in the rows above would claim
        // production held a row it did not, and adding it to the expectation
        // would make a 2026-10-24 measurement depend on what the code gates
        // on today.
        //
        // The claim worth keeping is historical: of the keys referenced THEN,
        // exactly these two had no row. Intersecting with that set says it
        // precisely and cannot be disturbed by a seventh key.
        const REFERENCED_ON_2026_10_24 = [
            'integrations.google',
            'notifications.sse',
            'social.farm-media',
            'social.farm-registration',
            'social.person-blocks',
            'social.public-profile',
        ];
        const r = await featureFlagsCapability(
            reader([
                'notifications.sse',
                'social.farm-registration',
                'social.person-blocks',
                'social.public-profile',
            ]),
        );
        expect(r.state).toBe('incomplete');
        expect(r.missingRows.filter((k) => REFERENCED_ON_2026_10_24.includes(k))).toEqual([
            'integrations.google',
            'social.farm-media',
        ]);
        expect(r.orphanRows).toBe(0);
    });

    it('an EMPTY table is incomplete, and orphanRows says it was really empty', async () => {
        // The reading that separates "missing two" from "I read nothing". An
        // empty result reports every key missing with perfect confidence, and
        // the orphan count beside it is what makes the two distinguishable.
        const r = await featureFlagsCapability(reader([]));
        expect(r.state).toBe('incomplete');
        // Narrowed by #2841: the two DECIDED absences move to `dormantRows`,
        // so this is every OTHER referenced key. The state is still
        // `incomplete`, which is the point — an empty table is not a
        // deliberate configuration.
        expect(r.missingRows).toEqual(
            REFERENCED_FLAG_KEYS.filter(
                (k) => !(DELIBERATELY_ROWLESS_FLAG_KEYS as readonly string[]).includes(k),
            ).sort(),
        );
        expect([...r.dormantRows].sort()).toEqual(
            [...DELIBERATELY_ROWLESS_FLAG_KEYS].sort(),
        );
        expect(r.staleDormantEntries).toEqual([]);
        expect(r.referenced).toBe(REFERENCED_FLAG_KEYS.length);
        expect(r.orphanRows).toBe(0);
    });

    /**
     * The #2841 split: a DECIDED absence is not an alarm, and is not hidden.
     */
    it('the two dormant keys do NOT make the state incomplete', async () => {
        // Production, 2026-11-27: every referenced key has a row EXCEPT the
        // two dormant ones. `Feature flag coverage` failed on this exact
        // state every day for six days.
        const live = REFERENCED_FLAG_KEYS.filter(
            (k) => !(DELIBERATELY_ROWLESS_FLAG_KEYS as readonly string[]).includes(k),
        );
        const r = await featureFlagsCapability(reader([...live]));

        expect(r.state).toBe('complete');
        expect(r.missingRows).toEqual([]);
        // NOT hidden — named, so `/api/readyz` still says which surfaces are
        // deliberately dark.
        expect([...r.dormantRows].sort()).toEqual(
            [...DELIBERATELY_ROWLESS_FLAG_KEYS].sort(),
        );
        expect(r.staleDormantEntries).toEqual([]);
    });

    it('CONTROL: an UNDECIDED absence still turns the state incomplete', async () => {
        // Without this, "dormant keys are fine" is satisfied by a capability
        // that stopped reporting missing rows at all — which is the failure
        // this whole split could easily have become.
        const live = REFERENCED_FLAG_KEYS.filter(
            (k) => !(DELIBERATELY_ROWLESS_FLAG_KEYS as readonly string[]).includes(k),
        );
        const victim = live[0]!;
        const r = await featureFlagsCapability(
            reader(live.filter((k) => k !== victim)),
        );

        expect(r.state).toBe('incomplete');
        expect(r.missingRows).toEqual([victim]);
        // And the dormant pair is still reported beside it, so one undecided
        // miss does not swallow the decided ones.
        expect([...r.dormantRows].sort()).toEqual(
            [...DELIBERATELY_ROWLESS_FLAG_KEYS].sort(),
        );
    });

    it('a dormant key that GAINED a row is reported as a stale entry', async () => {
        // The decision was reversed and the list has outlived it. Reported
        // rather than silently tolerated, because an allowlist entry that is
        // no longer needed reads exactly like a covered case.
        const reversed = DELIBERATELY_ROWLESS_FLAG_KEYS[0]!;
        const live = REFERENCED_FLAG_KEYS.filter(
            (k) =>
                !(DELIBERATELY_ROWLESS_FLAG_KEYS as readonly string[]).includes(k) ||
                k === reversed,
        );
        const r = await featureFlagsCapability(reader([...live]));

        expect(r.staleDormantEntries).toEqual([reversed]);
        // It is NOT an alarm: the surface is live and working.
        expect(r.state).toBe('complete');
        expect(r.dormantRows).not.toContain(reversed);
    });

    it('a row nothing gates on is an ORPHAN, never a missing key', async () => {
        // A retired flag. Harmless, and it must not make the verdict
        // incomplete — a check that reddened on a leftover row would be
        // reporting the operator's own tidy-up as a fault.
        const r = await featureFlagsCapability(
            reader([...REFERENCED_FLAG_KEYS, 'social.retired-surface']),
        );
        expect(r.state).toBe('complete');
        expect(r.missingRows).toEqual([]);
        expect(r.orphanRows).toBe(1);
    });

    it('an unreadable table is UNKNOWN, not incomplete', async () => {
        // The false-alarm direction. During a database incident every probe
        // would otherwise claim a configuration fault that does not exist, and
        // `checks.database` is the signal that should fire in that window.
        const r = await featureFlagsCapability(throwing());
        expect(r.state).toBe('unknown');
        expect(r.missingRows).toEqual([]);
        // And it still reports the denominator, so the reading is not silent
        // about what it was unable to check.
        expect(r.referenced).toBe(REFERENCED_FLAG_KEYS.length);
    });

    it('never throws, whatever the reader does', async () => {
        // It runs inside `readyz`, which must answer. A capability that threw
        // would take down the endpoint the uptime check reads — the exact
        // outcome the WATCHED-not-gated placement exists to prevent.
        await expect(featureFlagsCapability(throwing())).resolves.toBeDefined();
    });

    it('does not report a key as missing merely because a row is disabled', async () => {
        // The distinction the docblock draws. This capability reads only `key`,
        // so a disabled row is present — and `enabled=false` is a legitimate
        // state for a dark-launched surface. Pinned because "has a row" and "is
        // on" are the two questions #2009 says must not be collapsed, and a
        // future edit selecting `enabled` too would be the way to collapse them.
        const r = await featureFlagsCapability(reader([...REFERENCED_FLAG_KEYS]));
        expect(r.state).toBe('complete');
    });
});
