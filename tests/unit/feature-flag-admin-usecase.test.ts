/**
 * The flag-admin usecase, driven directly.
 *
 * The console's HTTP tests (`tests/unit/admin-feature-flags-console.test.ts`)
 * exercise all of this THROUGH the routes, so this file is not here to repeat
 * them. It exists for the properties that are invisible from the HTTP side:
 *
 *   · **The write happens BEFORE the invalidation.** Reversed, a concurrent
 *     reader could repopulate the 30s cache from the pre-write table and the
 *     flip would stay invisible for the full TTL — the exact failure the
 *     invalidation exists to prevent. Both orders return the same 200, so no
 *     response assertion can tell them apart; only call order can.
 *   · **The truncation boundary**, at exactly the page size and one below it.
 *     A `>=` would report a full-but-complete page as truncated; a `>` would
 *     never fire at all.
 *   · **The kill switch is unreachable from this module**, asserted over the
 *     module's own exports rather than by reading the source — a claim about
 *     what an API cannot do is worth more than a comment saying so.
 */
// The mock doubles are built INSIDE the factories and read back through the
// mocked imports, rather than declared as consts above them. `jest.mock` calls
// are hoisted above the module's own statements but the factories run at REQUIRE
// time, which for a top-level import is before any `const` initialiser — so the
// obvious shape throws `Cannot access 'mockFeatureFlag' before initialization`.
// A lazy `require()` inside a loader would also work, and is what the sibling
// console test does, but `tests/guardrails/usecase-test-coverage.test.ts` only
// counts `from '<specifier>'` imports: a usecase reached by `require` would read
// as untested.
jest.mock('@/lib/prisma', () => ({
    prisma: {
        featureFlag: { findMany: jest.fn(), upsert: jest.fn() },
        featureFlagCohortMember: {
            findMany: jest.fn(),
            groupBy: jest.fn(),
            createMany: jest.fn(),
            deleteMany: jest.fn(),
        },
    },
}));
jest.mock('@/lib/feature-flags', () => ({
    ...jest.requireActual('@/lib/feature-flags'),
    invalidateFlagCache: jest.fn(),
}));

import * as flagAdmin from '@/app-layer/usecases/feature-flag-admin';
import { COHORT_MEMBER_PAGE_SIZE } from '@/app-layer/usecases/feature-flag-admin';
import { prisma } from '@/lib/prisma';
import { invalidateFlagCache } from '@/lib/feature-flags';

export {};

type Fn = jest.Mock;
const mockFeatureFlag = prisma.featureFlag as unknown as { findMany: Fn; upsert: Fn };
const mockCohortMember = prisma.featureFlagCohortMember as unknown as {
    findMany: Fn;
    groupBy: Fn;
    createMany: Fn;
    deleteMany: Fn;
};
const invalidateSpy = invalidateFlagCache as unknown as Fn;

const ROW = {
    key: 'social.feed',
    enabled: true,
    cohorts: [] as string[],
    description: null,
    updatedAt: new Date('2026-10-02T00:00:00.000Z'),
};

beforeEach(() => {
    jest.clearAllMocks();
    mockFeatureFlag.findMany.mockResolvedValue([]);
    mockFeatureFlag.upsert.mockResolvedValue(ROW);
    mockCohortMember.findMany.mockResolvedValue([]);
    mockCohortMember.groupBy.mockResolvedValue([]);
    mockCohortMember.createMany.mockResolvedValue({ count: 1 });
    mockCohortMember.deleteMany.mockResolvedValue({ count: 1 });
    invalidateSpy.mockResolvedValue(undefined);
});

describe('upsertFeatureFlag writes, THEN invalidates', () => {
    it('the order is write → invalidate, not the reverse', async () => {
        const order: string[] = [];
        mockFeatureFlag.upsert.mockImplementation(async () => {
            order.push('write');
            return ROW;
        });
        invalidateSpy.mockImplementation(async () => {
            order.push('invalidate');
        });

        await flagAdmin.upsertFeatureFlag({ key: 'social.feed', enabled: true, cohorts: [] });

        // Invalidating first leaves a window in which a reader repopulates the
        // cache from the OLD table, and the flip is then invisible for the full
        // 30s TTL — indistinguishable from the console not working.
        expect(order).toEqual(['write', 'invalidate']);
    });

    it('still invalidates when the row did not change value', async () => {
        // Re-flipping a flag to the state it already holds is a no-op row-wise
        // and still has to drop the cache: the operator may be flipping it
        // BACK after a flip that is currently cached.
        await flagAdmin.upsertFeatureFlag({ key: 'social.feed', enabled: true, cohorts: [] });
        expect(invalidateSpy).toHaveBeenCalledTimes(1);
    });

    it('does NOT invalidate when the write throws', async () => {
        mockFeatureFlag.upsert.mockRejectedValue(new Error('constraint'));
        await expect(
            flagAdmin.upsertFeatureFlag({ key: 'social.feed', enabled: true, cohorts: [] }),
        ).rejects.toThrow('constraint');
        // Dropping the cache for a write that did not land costs every flag
        // read a round-trip and advertises a change that never happened.
        expect(invalidateSpy).not.toHaveBeenCalled();
    });

    it('cohorts reach Prisma on BOTH arms of the upsert', async () => {
        await flagAdmin.upsertFeatureFlag({
            key: 'social.feed',
            enabled: true,
            cohorts: ['beta'],
        });
        const arg = mockFeatureFlag.upsert.mock.calls[0][0];
        // The update arm is the one that matters: `undefined` there means
        // "leave it alone", so a flag that HAS cohorts would keep its old
        // narrowing while the caller believes it was replaced.
        expect(arg.create.cohorts).toEqual(['beta']);
        expect(arg.update.cohorts).toEqual(['beta']);
    });

    it('description is three-state at this boundary too', async () => {
        await flagAdmin.upsertFeatureFlag({ key: 'social.feed', enabled: true, cohorts: [] });
        expect(mockFeatureFlag.upsert.mock.calls[0][0].update).not.toHaveProperty('description');

        jest.clearAllMocks();
        mockFeatureFlag.upsert.mockResolvedValue(ROW);
        await flagAdmin.upsertFeatureFlag({
            key: 'social.feed',
            enabled: true,
            cohorts: [],
            description: null,
        });
        expect(mockFeatureFlag.upsert.mock.calls[0][0].update.description).toBeNull();
    });

    it('never writes updatedByUserId', async () => {
        await flagAdmin.upsertFeatureFlag({ key: 'social.feed', enabled: true, cohorts: [] });
        const arg = mockFeatureFlag.upsert.mock.calls[0][0];
        expect(arg.create).not.toHaveProperty('updatedByUserId');
        expect(arg.update).not.toHaveProperty('updatedByUserId');
    });
});

describe('the truncation boundary is exact', () => {
    it.each([
        [COHORT_MEMBER_PAGE_SIZE - 1, false],
        [COHORT_MEMBER_PAGE_SIZE, true],
    ])('%i members -> truncated=%s', async (count, expected) => {
        mockCohortMember.findMany.mockResolvedValue(
            Array.from({ length: count }, (_, i) => ({ userId: `u${i}`, createdAt: new Date(0) })),
        );
        const { members, truncated } = await flagAdmin.listCohortMembers('beta');
        expect(members).toHaveLength(count);
        expect(truncated).toBe(expected);
    });

    it('asks Prisma for exactly the page size — the bound is real, not decorative', async () => {
        await flagAdmin.listCohortMembers('beta');
        expect(mockCohortMember.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ take: COHORT_MEMBER_PAGE_SIZE }),
        );
    });

    it('an empty cohort is not truncated', async () => {
        const { members, truncated } = await flagAdmin.listCohortMembers('beta');
        expect(members).toEqual([]);
        expect(truncated).toBe(false);
    });
});

describe('cohort sizes are reshaped, and a zero-member cohort cannot appear', () => {
    it('maps groupBy output to {cohort, members}', async () => {
        mockCohortMember.groupBy.mockResolvedValue([
            { cohortKey: 'beta', _count: { _all: 3 } },
            { cohortKey: 'staff', _count: { _all: 1 } },
        ]);
        expect(await flagAdmin.listCohortSizes()).toEqual([
            { cohort: 'beta', members: 3 },
            { cohort: 'staff', members: 1 },
        ]);
    });

    it('a cohort NAMED on a flag but with no members returns nothing here', async () => {
        // There is no row to group, so `groupBy` cannot report it. That is why
        // the console reads this list ALONGSIDE the flag list: a flag enabled
        // against a cohort absent from this result is off for everyone while
        // reading as a live rollout. Pinned so the gap is documented as
        // behaviour rather than discovered by an operator.
        mockCohortMember.groupBy.mockResolvedValue([]);
        expect(await flagAdmin.listCohortSizes()).toEqual([]);
    });
});

describe('membership writes are idempotent by construction', () => {
    it('add relies on the unique constraint rather than a read-then-write', async () => {
        await flagAdmin.addCohortMember('beta', 'u1');
        expect(mockCohortMember.createMany).toHaveBeenCalledWith(
            expect.objectContaining({ skipDuplicates: true }),
        );
        // No read before the write: a check-then-insert races two operators.
        expect(mockCohortMember.findMany).not.toHaveBeenCalled();
    });

    it('add reports whether a row was actually created', async () => {
        mockCohortMember.createMany.mockResolvedValue({ count: 0 });
        expect(await flagAdmin.addCohortMember('beta', 'u1')).toEqual({ added: false });
        mockCohortMember.createMany.mockResolvedValue({ count: 1 });
        expect(await flagAdmin.addCohortMember('beta', 'u1')).toEqual({ added: true });
    });

    it('remove returns the COUNT, so a no-op is distinguishable from a removal', async () => {
        mockCohortMember.deleteMany.mockResolvedValue({ count: 0 });
        expect(await flagAdmin.removeCohortMember('beta', 'u1')).toEqual({ removed: 0 });
    });

    it('remove scopes to the pair — never a whole cohort', async () => {
        await flagAdmin.removeCohortMember('beta', 'u1');
        expect(mockCohortMember.deleteMany).toHaveBeenCalledWith({
            where: { cohortKey: 'beta', userId: 'u1' },
        });
    });

    it('neither membership write touches the flag cache', async () => {
        await flagAdmin.addCohortMember('beta', 'u1');
        await flagAdmin.removeCohortMember('beta', 'u1');
        // `cohortsFor` is read per request and is NOT cached, so there is
        // nothing to invalidate; dropping the flag table's cache here would
        // cost every flag read a round-trip to no effect.
        expect(invalidateSpy).not.toHaveBeenCalled();
    });
});

describe('the kill switch is not reachable from this module', () => {
    it('no export changes FEATURE_FLAGS_FORCE_OFF', async () => {
        // Asserted over the module's exports and the environment, not by
        // reading the source for an absence. `FEATURE_FLAGS_FORCE_OFF` is the
        // control that works when the application is the thing going wrong, so
        // an API able to clear it is an API that can be compromised into
        // clearing it.
        const before = process.env.FEATURE_FLAGS_FORCE_OFF;
        await flagAdmin.upsertFeatureFlag({ key: 'social.feed', enabled: true, cohorts: [] });
        await flagAdmin.addCohortMember('beta', 'u1');
        await flagAdmin.removeCohortMember('beta', 'u1');
        await flagAdmin.listFeatureFlags();
        await flagAdmin.listCohortSizes();
        await flagAdmin.listCohortMembers('beta');
        expect(process.env.FEATURE_FLAGS_FORCE_OFF).toBe(before);

        // And the surface is exactly these six — a seventh export is a new
        // operation that has to argue for itself here.
        expect(Object.keys(flagAdmin).filter((k) => typeof (flagAdmin as Record<string, unknown>)[k] === 'function').sort()).toEqual([
            'addCohortMember',
            'listCohortMembers',
            'listCohortSizes',
            'listFeatureFlags',
            'removeCohortMember',
            'upsertFeatureFlag',
        ]);
    });
});
