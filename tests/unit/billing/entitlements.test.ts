/**
 * GAP-18 — Plan-entitlement evaluation + enforcement tests.
 *
 * Covers four behaviours the entitlement layer is responsible for:
 *
 *   1. SaaS vs self-hosted mode decision (`getBillingMode`).
 *   2. Effective-plan resolution per tenant under each mode
 *      (`getEffectivePlan`).
 *   3. Per-plan limit lookup (`getLimit`).
 *   4. Pre-mutation gate (`assertWithinLimit`):
 *        - refuses with `PLAN_LIMIT_EXCEEDED` + params at the cap,
 *        - lets the call through under the cap,
 *        - never throws under ENTERPRISE / SELFHOSTED.
 *
 * The mode decision is read at module load, so each test's mode
 * scenario is exercised by setting `STRIPE_SECRET_KEY` and then
 * `jest.resetModules()` + dynamic-importing the entitlements
 * module fresh.
 *
 * GRC teardown phase 3 removed `practice` from `GatedResource` along
 * with the model. The `assertWithinLimit` block below was RE-POINTED at
 * `location` rather than deleted: `location` is the same shape (a
 * tenant-scoped row count with soft-deleted rows excluded) under a
 * different cap (FREE 5 / working tiers 50), so every property the
 * practice block pinned — the SELFHOSTED short-circuit, the
 * at-the-cap boundary, the above-the-cap message, the unlimited path
 * never issuing a count — is still exercised against live code.
 */

const ORIGINAL_STRIPE = process.env.STRIPE_SECRET_KEY;

// Helper: import a fresh module instance after env mutation.
async function loadEntitlements(stripeKey: string | undefined) {
    if (stripeKey === undefined) {
        delete process.env.STRIPE_SECRET_KEY;
    } else {
        process.env.STRIPE_SECRET_KEY = stripeKey;
    }
    jest.resetModules();
    return await import('@/lib/billing/entitlements');
}

afterAll(() => {
    if (ORIGINAL_STRIPE === undefined) {
        delete process.env.STRIPE_SECRET_KEY;
    } else {
        process.env.STRIPE_SECRET_KEY = ORIGINAL_STRIPE;
    }
});

describe('getBillingMode', () => {
    it('returns SELFHOSTED when STRIPE_SECRET_KEY is unset', async () => {
        const mod = await loadEntitlements(undefined);
        expect(mod.getBillingMode()).toBe('SELFHOSTED');
    });

    it('returns SAAS when STRIPE_SECRET_KEY is set', async () => {
        const mod = await loadEntitlements('sk_test_dummy');
        expect(mod.getBillingMode()).toBe('SAAS');
    });

    it('treats empty STRIPE_SECRET_KEY as unset (still SELFHOSTED)', async () => {
        const mod = await loadEntitlements('');
        expect(mod.getBillingMode()).toBe('SELFHOSTED');
    });
});

describe('getLimit', () => {
    it('caps the monthly AI-token budget by tier', async () => {
        const mod = await loadEntitlements(undefined);
        expect(mod.getLimit('FREE', 'ai_tokens')).toBe(50_000);
        expect(mod.getLimit('TRIAL', 'ai_tokens')).toBe(1_000_000);
        expect(mod.getLimit('PRO', 'ai_tokens')).toBe(5_000_000);
        expect(mod.getLimit('ENTERPRISE', 'ai_tokens')).toBeNull();
    });
    it('caps users + locations for FREE (startup-farmer tier)', async () => {
        const mod = await loadEntitlements(undefined);
        expect(mod.getLimit('FREE', 'user')).toBe(3);
        expect(mod.getLimit('FREE', 'location')).toBe(5);
    });
    it('lifts user + location caps for PRO/TRIAL, unlimited on ENTERPRISE', async () => {
        const mod = await loadEntitlements(undefined);
        expect(mod.getLimit('PRO', 'user')).toBe(25);
        expect(mod.getLimit('TRIAL', 'location')).toBe(50);
        expect(mod.getLimit('ENTERPRISE', 'user')).toBeNull();
        expect(mod.getLimit('ENTERPRISE', 'location')).toBeNull();
    });
    it('caps exchange listings: FREE 5, PRO/TRIAL 50, ENTERPRISE unlimited', async () => {
        const mod = await loadEntitlements(undefined);
        expect(mod.getLimit('FREE', 'exchange_listing')).toBe(5);
        expect(mod.getLimit('PRO', 'exchange_listing')).toBe(50);
        expect(mod.getLimit('TRIAL', 'exchange_listing')).toBe(50);
        expect(mod.getLimit('ENTERPRISE', 'exchange_listing')).toBeNull();
    });
});

describe('assertWithinLimit — exchange_listing', () => {
    it('SELFHOSTED: unlimited — never queries the ACTIVE-listing count', async () => {
        const mod = await loadEntitlements(undefined);
        const dbCtx = (await import('@/lib/db-context')) as unknown as {
            __stub: { exchangeListing: { count: jest.MockedFunction<(args: unknown) => Promise<number>> } };
        };
        await expect(
            mod.assertWithinLimit(makeRequestContext('ADMIN'), 'exchange_listing'),
        ).resolves.toBeUndefined();
        expect(dbCtx.__stub.exchangeListing.count).not.toHaveBeenCalled();
    });

    it('SAAS FREE: passes below the 5-listing cap', async () => {
        const mod = await loadEntitlements('sk_test_dummy');
        const dbCtx = (await import('@/lib/db-context')) as unknown as {
            __stub: {
                billingAccount: { findUnique: jest.MockedFunction<(args: unknown) => Promise<unknown>> };
                exchangeListing: { count: jest.MockedFunction<(args: unknown) => Promise<number>> };
            };
        };
        dbCtx.__stub.billingAccount.findUnique.mockResolvedValue({ plan: 'FREE' });
        dbCtx.__stub.exchangeListing.count.mockResolvedValue(4);
        await expect(
            mod.assertWithinLimit(makeRequestContext('ADMIN'), 'exchange_listing'),
        ).resolves.toBeUndefined();
    });

    it('SAAS FREE: refuses with PLAN_LIMIT_EXCEEDED at exactly 5 ACTIVE listings', async () => {
        const mod = await loadEntitlements('sk_test_dummy');
        const dbCtx = (await import('@/lib/db-context')) as unknown as {
            __stub: {
                billingAccount: { findUnique: jest.MockedFunction<(args: unknown) => Promise<unknown>> };
                exchangeListing: { count: jest.MockedFunction<(args: unknown) => Promise<number>> };
            };
        };
        dbCtx.__stub.billingAccount.findUnique.mockResolvedValue({ plan: 'FREE' });
        dbCtx.__stub.exchangeListing.count.mockResolvedValue(5);
        await expect(
            mod.assertWithinLimit(makeRequestContext('ADMIN'), 'exchange_listing'),
        ).rejects.toMatchObject({
            status: 403,
            // The CODE and PARAMS, not the prose. The legacy
            // `plan_limit_exceeded:` prefix is gone (#1677) and `message` is
            // now translated per reader, so asserting on it would pin a
            // sentence that legitimately changes with the catalogue.
            code: 'PLAN_LIMIT_EXCEEDED',
            params: { plan: 'FREE', resource: 'exchange_listing', limit: '5', current: '5' },
        });
    });
});

// ─── Mocks for plan resolution + count ──────────────────────────
//
// `getEffectivePlan` and `assertWithinLimit` both depend on the
// shared db-context wrapper. We mock `runInTenantContext` to
// hand the inner callback a stub `db` whose shape covers just
// `billingAccount.findUnique` and the two counted resources.

/**
 * `assertTenantNotPastDueRestricted` reads `@/lib/prisma` rather than
 * `db-context` — `BillingAccount` is not RLS-scoped, so it goes to the global
 * client. Mocked separately for that reason; the two are not interchangeable
 * here (#2030).
 */
jest.mock('@/lib/prisma', () => ({
    prisma: { billingAccount: { findUnique: jest.fn() } },
}));

jest.mock('@/lib/db-context', () => {
    const stub = {
        billingAccount: {
            findUnique: jest.fn(),
        },
        location: {
            count: jest.fn(),
        },
        exchangeListing: {
            count: jest.fn(),
        },
    };
    return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runInTenantContext: jest.fn(async (_ctx: unknown, fn: any) => fn(stub)),
        __stub: stub,
    };
});

import { makeRequestContext } from '../../helpers/make-context';

describe('getEffectivePlan', () => {
    it('returns ENTERPRISE under SELFHOSTED mode regardless of stored plan', async () => {
        const mod = await loadEntitlements(undefined);
        // Even if a BillingAccount row exists with FREE, self-hosted
        // ignores it. Set a return value the function should NOT use.
        const dbCtx = (await import('@/lib/db-context')) as unknown as {
            __stub: {
                billingAccount: {
                    findUnique: jest.MockedFunction<(args: unknown) => Promise<unknown>>;
                };
            };
        };
        dbCtx.__stub.billingAccount.findUnique.mockResolvedValue({ plan: 'FREE' });

        const plan = await mod.getEffectivePlan(makeRequestContext('ADMIN'));
        expect(plan).toBe('ENTERPRISE');
        // Importantly, in SELFHOSTED the DB MUST NOT be queried.
        expect(dbCtx.__stub.billingAccount.findUnique).not.toHaveBeenCalled();
    });

    it('reads BillingAccount.plan under SAAS mode', async () => {
        const mod = await loadEntitlements('sk_test_dummy');
        const dbCtx = (await import('@/lib/db-context')) as unknown as {
            __stub: {
                billingAccount: {
                    findUnique: jest.MockedFunction<(args: unknown) => Promise<unknown>>;
                };
            };
        };
        dbCtx.__stub.billingAccount.findUnique.mockResolvedValue({ plan: 'PRO' });

        const plan = await mod.getEffectivePlan(makeRequestContext('ADMIN'));
        expect(plan).toBe('PRO');
        expect(dbCtx.__stub.billingAccount.findUnique).toHaveBeenCalledTimes(1);
    });

    it('treats SaaS tenant with no BillingAccount row as FREE', async () => {
        const mod = await loadEntitlements('sk_test_dummy');
        const dbCtx = (await import('@/lib/db-context')) as unknown as {
            __stub: {
                billingAccount: {
                    findUnique: jest.MockedFunction<(args: unknown) => Promise<unknown>>;
                };
            };
        };
        dbCtx.__stub.billingAccount.findUnique.mockResolvedValue(null);

        const plan = await mod.getEffectivePlan(makeRequestContext('ADMIN'));
        expect(plan).toBe('FREE');
    });
});

describe('assertWithinLimit — location', () => {
    it('SELFHOSTED: passes regardless of count (no DB count query)', async () => {
        const mod = await loadEntitlements(undefined);
        const dbCtx = (await import('@/lib/db-context')) as unknown as {
            __stub: {
                location: { count: jest.MockedFunction<(args: unknown) => Promise<number>> };
            };
        };
        // Even if there are millions of rows, ENTERPRISE is unlimited.
        dbCtx.__stub.location.count.mockResolvedValue(9_999_999);

        await expect(
            mod.assertWithinLimit(makeRequestContext('ADMIN'), 'location'),
        ).resolves.toBeUndefined();
        // Unlimited path — count not even queried.
        expect(dbCtx.__stub.location.count).not.toHaveBeenCalled();
    });

    it('SAAS FREE: passes when current < 5', async () => {
        const mod = await loadEntitlements('sk_test_dummy');
        const dbCtx = (await import('@/lib/db-context')) as unknown as {
            __stub: {
                billingAccount: {
                    findUnique: jest.MockedFunction<(args: unknown) => Promise<unknown>>;
                };
                location: { count: jest.MockedFunction<(args: unknown) => Promise<number>> };
            };
        };
        dbCtx.__stub.billingAccount.findUnique.mockResolvedValue({ plan: 'FREE' });
        dbCtx.__stub.location.count.mockResolvedValue(4);

        await expect(
            mod.assertWithinLimit(makeRequestContext('ADMIN'), 'location'),
        ).resolves.toBeUndefined();
    });

    it('SAAS FREE: refuses with PLAN_LIMIT_EXCEEDED at exactly 5', async () => {
        const mod = await loadEntitlements('sk_test_dummy');
        const dbCtx = (await import('@/lib/db-context')) as unknown as {
            __stub: {
                billingAccount: {
                    findUnique: jest.MockedFunction<(args: unknown) => Promise<unknown>>;
                };
                location: { count: jest.MockedFunction<(args: unknown) => Promise<number>> };
            };
        };
        dbCtx.__stub.billingAccount.findUnique.mockResolvedValue({ plan: 'FREE' });
        dbCtx.__stub.location.count.mockResolvedValue(5);

        await expect(
            mod.assertWithinLimit(makeRequestContext('ADMIN'), 'location'),
        ).rejects.toMatchObject({ status: 403, code: 'PLAN_LIMIT_EXCEEDED' });
    });

    it('SAAS FREE: throws above 5', async () => {
        const mod = await loadEntitlements('sk_test_dummy');
        const dbCtx = (await import('@/lib/db-context')) as unknown as {
            __stub: {
                billingAccount: {
                    findUnique: jest.MockedFunction<(args: unknown) => Promise<unknown>>;
                };
                location: { count: jest.MockedFunction<(args: unknown) => Promise<number>> };
            };
        };
        dbCtx.__stub.billingAccount.findUnique.mockResolvedValue({ plan: 'FREE' });
        dbCtx.__stub.location.count.mockResolvedValue(42);

        await expect(
            mod.assertWithinLimit(makeRequestContext('ADMIN'), 'location'),
        ).rejects.toThrow(/FREE plan allows 5 location/);
    });

    it('SAAS PRO: passes at 20 (below 50)', async () => {
        const mod = await loadEntitlements('sk_test_dummy');
        const dbCtx = (await import('@/lib/db-context')) as unknown as {
            __stub: {
                billingAccount: {
                    findUnique: jest.MockedFunction<(args: unknown) => Promise<unknown>>;
                };
                location: { count: jest.MockedFunction<(args: unknown) => Promise<number>> };
            };
        };
        dbCtx.__stub.billingAccount.findUnique.mockResolvedValue({ plan: 'PRO' });
        dbCtx.__stub.location.count.mockResolvedValue(20);

        await expect(
            mod.assertWithinLimit(makeRequestContext('ADMIN'), 'location'),
        ).resolves.toBeUndefined();
    });

    it('SAAS ENTERPRISE: passes at any count (unlimited)', async () => {
        const mod = await loadEntitlements('sk_test_dummy');
        const dbCtx = (await import('@/lib/db-context')) as unknown as {
            __stub: {
                billingAccount: {
                    findUnique: jest.MockedFunction<(args: unknown) => Promise<unknown>>;
                };
                location: { count: jest.MockedFunction<(args: unknown) => Promise<number>> };
            };
        };
        dbCtx.__stub.billingAccount.findUnique.mockResolvedValue({ plan: 'ENTERPRISE' });
        // The count helper would skip when limit is null; assert it
        // never gets called rather than mocking a value.

        await expect(
            mod.assertWithinLimit(makeRequestContext('ADMIN'), 'location'),
        ).resolves.toBeUndefined();
        expect(dbCtx.__stub.location.count).not.toHaveBeenCalled();
    });

    it('params carry plan, resource, limit and current — the values a client needs', async () => {
        const mod = await loadEntitlements('sk_test_dummy');
        const dbCtx = (await import('@/lib/db-context')) as unknown as {
            __stub: {
                billingAccount: {
                    findUnique: jest.MockedFunction<(args: unknown) => Promise<unknown>>;
                };
                location: { count: jest.MockedFunction<(args: unknown) => Promise<number>> };
            };
        };
        dbCtx.__stub.billingAccount.findUnique.mockResolvedValue({ plan: 'FREE' });
        dbCtx.__stub.location.count.mockResolvedValue(13);

        try {
            await mod.assertWithinLimit(makeRequestContext('ADMIN'), 'location');
            fail('expected throw');
        } catch (err) {
            // On `params`, not on the message. This test used to read the
            // message "for billing-UI parsing", and #1677 measured that
            // premise false: ZERO `.tsx` files mention `plan_limit`, so no
            // billing UI ever parsed it. `UpgradeGate` takes a `feature` prop
            // and never looks at an error.
            //
            // The values a client needs are now where a client can use them —
            // and `message` is a translated sentence, so parsing it would be
            // parsing Bulgarian.
            const e = err as { code?: string; params?: Record<string, string> };
            expect(e.code).toBe('PLAN_LIMIT_EXCEEDED');
            expect(e.params).toEqual({
                plan: 'FREE', resource: 'location', limit: '5', current: '13',
            });
        }
    });
});

/**
 * ── the tenantId gate actually REFUSES — #2030 ──
 *
 * This had no behavioural test, and #2030 is why that mattered. The gate's
 * decision logic is covered by `past-due-grace.test.ts` (when is a tenant
 * restricted) and its presence at every upload path is covered statically by
 * §5 of `past-due-capability-coverage`. Neither proves the wrapper THROWS, so
 * all five upload gates could have been no-ops with both green.
 *
 * The `ctx` sibling is exercised through `exchange-usecase.test.ts`. The
 * `tenantId` variant — the one every upload site calls — was untested.
 */
describe('assertTenantNotPastDueRestricted (#2030)', () => {
    const DAY = 24 * 60 * 60 * 1000;

    async function load() {
        const ent = await loadEntitlements('sk_test_saas');
        const { prisma } = (await import('@/lib/prisma')) as unknown as {
            prisma: { billingAccount: { findUnique: jest.Mock } };
        };
        return { ent, findUnique: prisma.billingAccount.findUnique };
    }

    it('refuses an upload once the grace has expired', async () => {
        const { ent, findUnique } = await load();
        findUnique.mockResolvedValue({
            status: 'PAST_DUE',
            // 15 days, one past the 14-day grace.
            pastDueSince: new Date(Date.now() - 15 * DAY),
        });

        // The MESSAGE, not a bare `toThrow()`. An argument-less `toThrow`
        // accepts any error — including a mock-plumbing TypeError from a
        // future refactor of this file's module mocks — so it would pass while
        // proving nothing about the refusal. Measured: the real rejection is
        // `ForbiddenError: Account payment is outstanding.`
        await expect(
            ent.assertTenantNotPastDueRestricted('t-1', 'upload'),
        ).rejects.toThrow(/payment is outstanding/i);
    });

    it('lets an upload through while still INSIDE the grace', async () => {
        // The discriminator. Without it, a gate that refused every PAST_DUE
        // tenant would pass the test above and silently break the 14-day
        // grace the owner's ruling grants.
        const { ent, findUnique } = await load();
        findUnique.mockResolvedValue({
            status: 'PAST_DUE',
            pastDueSince: new Date(Date.now() - 1 * DAY),
        });

        await expect(
            ent.assertTenantNotPastDueRestricted('t-1', 'upload'),
        ).resolves.toBeUndefined();
    });

    it('lets an ACTIVE tenant through', async () => {
        const { ent, findUnique } = await load();
        findUnique.mockResolvedValue({ status: 'ACTIVE', pastDueSince: null });

        await expect(
            ent.assertTenantNotPastDueRestricted('t-1', 'upload'),
        ).resolves.toBeUndefined();
    });

    it('lets a tenant with no billing row through', async () => {
        const { ent, findUnique } = await load();
        findUnique.mockResolvedValue(null);

        await expect(
            ent.assertTenantNotPastDueRestricted('t-1', 'upload'),
        ).resolves.toBeUndefined();
    });

    it('never queries billing under SELFHOSTED', async () => {
        // The short-circuit every upload path inherits in tests, which is
        // exactly why the suites that call those paths pass without proving
        // anything about the gate.
        const ent = await loadEntitlements(undefined);
        const { prisma } = (await import('@/lib/prisma')) as unknown as {
            prisma: { billingAccount: { findUnique: jest.Mock } };
        };
        prisma.billingAccount.findUnique.mockClear();

        await expect(
            ent.assertTenantNotPastDueRestricted('t-1', 'upload'),
        ).resolves.toBeUndefined();
        expect(prisma.billingAccount.findUnique).not.toHaveBeenCalled();
    });
});
