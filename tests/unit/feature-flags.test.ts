/**
 * The feature-flag resolver's precedence rules.
 *
 * Each rule here is one a wrong implementation would still LOOK right in a demo:
 * a kill switch that a warm cache defeats, an unknown flag defaulting on, or
 * cohorts read as OR instead of AND — which turns a limited rollout into a
 * global one. So they are asserted individually rather than through one happy
 * path.
 */
const mockFlags: { rows: Array<{ key: string; enabled: boolean; cohorts: string[] }> } = { rows: [] };
const mockMemberships: { rows: Array<{ cohortKey: string }> } = { rows: [] };

jest.mock('@/lib/prisma', () => ({
    prisma: {
        featureFlag: { findMany: jest.fn(async () => mockFlags.rows) },
        featureFlagCohortMember: { findMany: jest.fn(async () => mockMemberships.rows) },
    },
}));

// No Redis, which is also the dev/test reality — the resolver must work without
// it rather than treat its absence as an error.
jest.mock('@/lib/redis', () => ({ getRedis: () => null }));

import { resolveFlags, isFeatureEnabled, flagsForcedOff } from '@/lib/feature-flags';

const USER = 'u-1';

describe('feature flags — precedence', () => {
    beforeEach(() => {
        mockFlags.rows = [];
        mockMemberships.rows = [];
        delete process.env.FEATURE_FLAGS_FORCE_OFF;
    });

    it('an ABSENT flag is off', async () => {
        expect(await isFeatureEnabled('social.nothing', USER)).toBe(false);
        // And resolveFlags simply does not carry the key, rather than carrying false.
        expect(await resolveFlags(USER)).toEqual({});
    });

    it('enabled with NO cohorts is on for everyone', async () => {
        mockFlags.rows = [{ key: 'social.profiles', enabled: true, cohorts: [] }];
        expect(await isFeatureEnabled('social.profiles', USER)).toBe(true);
        expect(await isFeatureEnabled('social.profiles', null)).toBe(true);
    });

    it('disabled is off even for a cohort member', async () => {
        mockFlags.rows = [{ key: 'social.dm', enabled: false, cohorts: ['beta'] }];
        mockMemberships.rows = [{ cohortKey: 'beta' }];
        expect(await isFeatureEnabled('social.dm', USER)).toBe(false);
    });

    it('cohorts are AND, not OR — enabled is necessary, not sufficient', async () => {
        // The rule most likely to be got backwards, and the one whose failure is
        // an accidental global launch rather than a broken page.
        mockFlags.rows = [{ key: 'social.dm', enabled: true, cohorts: ['beta'] }];
        mockMemberships.rows = [];
        expect(await isFeatureEnabled('social.dm', USER)).toBe(false);

        mockMemberships.rows = [{ cohortKey: 'beta' }];
        expect(await isFeatureEnabled('social.dm', USER)).toBe(true);
    });

    it('an ANONYMOUS caller is in no cohort, so a cohort-gated flag is off', async () => {
        mockFlags.rows = [{ key: 'social.dm', enabled: true, cohorts: ['beta'] }];
        mockMemberships.rows = [{ cohortKey: 'beta' }]; // would match if consulted
        expect(await isFeatureEnabled('social.dm', null)).toBe(false);
    });

    it('membership in a DIFFERENT cohort does not open the flag', async () => {
        mockFlags.rows = [{ key: 'social.dm', enabled: true, cohorts: ['beta'] }];
        mockMemberships.rows = [{ cohortKey: 'staff' }];
        expect(await isFeatureEnabled('social.dm', USER)).toBe(false);
    });
});

describe('the kill switch', () => {
    beforeEach(() => {
        mockFlags.rows = [{ key: 'social.profiles', enabled: true, cohorts: [] }];
        mockMemberships.rows = [];
    });
    afterEach(() => {
        delete process.env.FEATURE_FLAGS_FORCE_OFF;
    });

    it('turns everything off and returns an EMPTY object', async () => {
        expect(await isFeatureEnabled('social.profiles', USER)).toBe(true);
        process.env.FEATURE_FLAGS_FORCE_OFF = '1';
        expect(await resolveFlags(USER)).toEqual({});
        expect(await isFeatureEnabled('social.profiles', USER)).toBe(false);
    });

    it('is read per call, so it works WITHIN one request and needs no restart', async () => {
        // A module-level constant would be fixed for the life of the process, so
        // a container that started before the switch was set would ignore it
        // until restarted — exactly when you need it to work.
        process.env.FEATURE_FLAGS_FORCE_OFF = '1';
        expect(flagsForcedOff()).toBe(true);
        delete process.env.FEATURE_FLAGS_FORCE_OFF;
        expect(flagsForcedOff()).toBe(false);
        // And the resolver follows it back, with no cache to clear.
        expect(await isFeatureEnabled('social.profiles', USER)).toBe(true);
    });

    it('only `1` engages it — a stray value does not silently kill the product', async () => {
        for (const v of ['0', 'true', 'yes', '', 'off']) {
            process.env.FEATURE_FLAGS_FORCE_OFF = v;
            expect(flagsForcedOff()).toBe(false);
        }
    });
});
