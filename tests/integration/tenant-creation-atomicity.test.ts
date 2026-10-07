/**
 * Real-DB proof that a mid-flight tenant creation leaves no half-made farm.
 *
 * ## Why this file exists under a new name
 *
 * It is the port of `register-atomicity.test.ts`, which proved the same
 * property against `POST /api/auth/register` — the legacy route retired with
 * #1376. Retiring a path is a forcing function, and this is what it surfaced:
 * the property is still IMPLEMENTED (`createTenantWithOwner` wraps tenant +
 * membership + onboarding in one transaction, by its own comment "so a midway
 * failure rolls back") but its only real-database proof lived in a test of the
 * route being deleted. Deleting that test would have left the live path's
 * rollback unproven while every unit test stayed green — and the old file's own
 * docblock drew exactly that line: *the unit tests assert the transaction is
 * USED; only a real database proves it ROLLS BACK.*
 *
 * `createTenantWithOwner` is now reached by `createFarmForUser` (P3.6's
 * `POST /api/me/farms`), which is the farm-creation path the wizard uses, and
 * by the platform-admin bootstrap. So the property matters on more paths than
 * it did before, not fewer.
 *
 * ## The behaviour DIFFERS from the route it replaces, deliberately
 *
 * The legacy route created the `User` INSIDE the transaction, so a rollback
 * removed it. `createTenantWithOwner` does the user find-or-upsert OUTSIDE,
 * with a written reason: the upsert has to be idempotent and visible to the
 * transaction below it. So on a failed attempt the user row SURVIVES and only
 * the tenant, membership and onboarding roll back.
 *
 * That is why this is a port and not a copy. Asserting `user.count === 0` —
 * the old file's first assertion — would fail here, and would be asserting the
 * wrong thing: a retained user is what makes the retry in the second test
 * succeed rather than collide.
 *
 * ## Technique, carried over because it was hard-won
 *
 * A naive `jest.spyOn(prisma.tenantOnboarding, 'create').mockRejectedValueOnce`
 * does NOT work against this codebase's singleton: `src/lib/prisma.ts` builds
 * `prisma` as a chain of `$extends(...)` wrappers, and Prisma constructs a
 * DISTINCT `tx` client for an interactive transaction, so spying on the outer
 * singleton's model method never touches the inner `tx`'s. The mock is silently
 * never hit and the call just succeeds. `induceTransactionFailure` wraps
 * `$transaction` itself: the real callback runs to completion (every row really
 * inserted) and then throws, so Prisma issues a real ROLLBACK.
 */
import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import prisma from '@/lib/prisma';
import { createTenantWithOwner } from '@/app-layer/usecases/tenant-lifecycle';
import { resetDatabase } from '../helpers/db';

/**
 * Make the NEXT `prisma.$transaction(...)` run its real callback — so every
 * write inside really hits Postgres — and then reject, so Prisma rolls the
 * whole transaction back.
 */
function induceTransactionFailure(client: PrismaClient) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bridging jest.spyOn's inferred overload against Prisma's interactive-transaction signature
    const original = (client.$transaction as any).bind(client);
    const mockImpl = (fn: (tx: unknown) => Promise<unknown>) =>
        original(async (tx: unknown) => {
            await fn(tx);
            throw new Error('induced failure');
        });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- $transaction's real type is a generic overload; the mock only needs to match the single-callback shape the usecase calls
    return jest.spyOn(client, '$transaction').mockImplementationOnce(mockImpl as any);
}

beforeEach(async () => {
    await resetDatabase(prisma);
    jest.restoreAllMocks();
});

// `resetDatabase()` deliberately does NOT truncate User / Tenant /
// TenantMembership / TenantOnboarding (see tests/helpers/db.ts) — other
// integration suites share long-lived fixtures there, and a full-suite run
// shares one Postgres across test FILES. So every identifier below is
// randomUUID()-suffixed, and every count is scoped to the row this test tried
// to create rather than asserted globally.

it('leaves no tenant, membership or onboarding behind when a late write fails', async () => {
    const email = `rollback-${randomUUID()}@example.com`;
    const slug = `rollback-${randomUUID().slice(0, 8)}`;
    const name = `Rollback Farms ${randomUUID()}`;

    induceTransactionFailure(prisma as unknown as PrismaClient);

    await expect(
        createTenantWithOwner({
            name,
            slug,
            ownerEmail: email,
            requestId: `req-${randomUUID()}`,
        }),
    ).rejects.toThrow();

    // The transaction's three writes must all be gone.
    expect(await prisma.tenant.count({ where: { slug } })).toBe(0);
    expect(await prisma.tenantMembership.count({ where: { tenant: { slug } } })).toBe(0);
    expect(await prisma.tenantOnboarding.count({ where: { tenant: { slug } } })).toBe(0);
});

it('RETAINS the user row — it is created outside the transaction on purpose', async () => {
    // The documented difference from the route this replaces, asserted rather
    // than assumed. If somebody moves the upsert inside the transaction to
    // "tidy up", this fails and the retry test below starts depending on
    // recreation instead of reuse.
    const email = `retain-${randomUUID()}@example.com`;
    const slug = `retain-${randomUUID().slice(0, 8)}`;

    induceTransactionFailure(prisma as unknown as PrismaClient);
    await expect(
        createTenantWithOwner({
            name: `Retain ${randomUUID()}`,
            slug,
            ownerEmail: email,
            requestId: `req-${randomUUID()}`,
        }),
    ).rejects.toThrow();

    // Rolled back…
    expect(await prisma.tenant.count({ where: { slug } })).toBe(0);
    // …but the owner survives, which is the point.
    expect(await prisma.user.count({ where: { email } })).toBe(1);
});

it('leaves the owner free to retry after a failed attempt', async () => {
    const email = `retry-${randomUUID()}@example.com`;
    const firstSlug = `retry-a-${randomUUID().slice(0, 8)}`;
    const secondSlug = `retry-b-${randomUUID().slice(0, 8)}`;

    induceTransactionFailure(prisma as unknown as PrismaClient);
    await expect(
        createTenantWithOwner({
            name: `Retry ${randomUUID()}`,
            slug: firstSlug,
            ownerEmail: email,
            requestId: `req-${randomUUID()}`,
        }),
    ).rejects.toThrow();

    // Second attempt, no induced failure. The retained user row has to be
    // REUSED rather than collide — the candidate-hash read before the upsert
    // is what makes that work, and a second User for one address is the defect
    // it exists to prevent.
    const result = await createTenantWithOwner({
        name: `Retry ${randomUUID()}`,
        slug: secondSlug,
        ownerEmail: email,
        requestId: `req-${randomUUID()}`,
    });

    expect(result.tenant.slug).toBe(secondSlug);
    expect(await prisma.tenant.count({ where: { slug: secondSlug } })).toBe(1);
    expect(await prisma.tenantMembership.count({ where: { tenant: { slug: secondSlug } } })).toBe(1);
    // Still exactly one user for this address.
    expect(await prisma.user.count({ where: { email } })).toBe(1);
});
