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
 *        - throws `forbidden(plan_limit_exceeded: …)` at the cap,
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

    it('SAAS FREE: throws plan_limit_exceeded at exactly 5 ACTIVE listings', async () => {
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
        ).rejects.toThrow(/plan_limit_exceeded: FREE plan allows 5 exchange_listing/);
    });
});

// ─── Mocks for plan resolution + count ──────────────────────────
//
// `getEffectivePlan` and `assertWithinLimit` both depend on the
// shared db-context wrapper. We mock `runInTenantContext` to
// hand the inner callback a stub `db` whose shape covers just
// `billingAccount.findUnique` and the two counted resources.

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

    it('SAAS FREE: throws plan_limit_exceeded at exactly 5', async () => {
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
        ).rejects.toThrow(/plan_limit_exceeded/);
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

    it('error message includes plan, limit, and current count for billing-UI parsing', async () => {
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
            const msg = (err as Error).message;
            expect(msg).toContain('plan_limit_exceeded');
            expect(msg).toContain('FREE');
            expect(msg).toContain('5');
            expect(msg).toContain('13');
        }
    });
});
