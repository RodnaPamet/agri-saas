/**
 * Real-DB proof that a mid-flight registration failure leaves nothing
 * behind. The unit tests (tests/unit/register-route.test.ts) assert the
 * transaction is USED; only a real database proves it ROLLS BACK.
 *
 * The failure is induced AFTER every write inside the transaction has
 * run for real against the database, but BEFORE Prisma commits — an
 * interactive transaction rolls back automatically when its callback
 * rejects, regardless of which statement "logically" failed. A slug
 * collision would not work as the trigger: the route appends a
 * Date.now() base36 suffix, so slugs never collide in practice.
 *
 * NOTE on technique: a naive `jest.spyOn(prisma.tenantOnboarding,
 * 'create').mockRejectedValueOnce(...)` (rejecting just the last model
 * call) does NOT work against this codebase's singleton client and was
 * verified empirically to fall through silently. `src/lib/prisma.ts`
 * builds `prisma` as a chain of `$extends(...)` wrappers (audit /
 * soft-delete / encryption / PII / RLS-tripwire), and Prisma constructs
 * a DISTINCT `tx` client object for the lifetime of an interactive
 * transaction — spying on the outer singleton's `tenantOnboarding.create`
 * never touches the inner `tx.tenantOnboarding.create`, so the mocked
 * rejection is silently never hit and the route just succeeds (200).
 * Instead, `induceTransactionFailure` wraps `prisma.$transaction`
 * itself: it lets the real callback run to completion (all four rows
 * really inserted) and then throws, so Prisma issues a real ROLLBACK.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import type { PrismaClient } from '@prisma/client';
import prisma from '@/lib/prisma';
import { resetDatabase } from '../helpers/db';
import { POST } from '@/app/api/auth/register/route';

function registerRequest(body: Record<string, unknown>): NextRequest {
    return new NextRequest('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'register', ...body }),
    });
}

/**
 * Make the NEXT `prisma.$transaction(...)` call run its real callback
 * (so every write inside it really hits Postgres) and then reject, so
 * Prisma rolls the whole transaction back. See the file-level comment
 * for why this is used instead of mocking an individual model method.
 */
function induceTransactionFailure(client: PrismaClient) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bridging jest.spyOn's inferred overload against Prisma's interactive-transaction signature
    const original = (client.$transaction as any).bind(client);
    const mockImpl = (fn: (tx: unknown) => Promise<unknown>) =>
        original(async (tx: unknown) => {
            await fn(tx);
            throw new Error('induced failure');
        });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- $transaction's real type is a generic overload; the mock only needs to match the single-callback shape the route actually calls
    return jest.spyOn(client, '$transaction').mockImplementationOnce(mockImpl as any);
}

beforeEach(async () => {
    await resetDatabase(prisma);
    jest.restoreAllMocks();
});

// `resetDatabase()` deliberately does NOT truncate User / Tenant /
// TenantMembership / TenantOnboarding (see tests/helpers/db.ts) — other
// integration suites share long-lived fixtures on those tables, and a
// full-suite run shares one Postgres instance across test FILES. So:
//   1. Fixture identifiers are randomUUID()-suffixed (the same pattern
//      tests/helpers/factories.ts uses) — collisions with leftover rows
//      from any other run or suite are structurally impossible.
//   2. The membership-count assertion is scoped to the tenant this test
//      tried to create, not asserted globally — the DB legitimately holds
//      other tenants' memberships when this file isn't running in total
//      isolation.

it('leaves no user, tenant or membership behind when a late write fails', async () => {
    const email = `rollback-${randomUUID()}@example.com`;
    const orgName = `Rollback Farms ${randomUUID()}`;

    induceTransactionFailure(prisma as unknown as PrismaClient);

    const res = await POST(
        registerRequest({
            email,
            password: 'a-long-unbreached-passphrase-1', // pragma: allowlist secret
            name: 'Rollback',
            orgName,
        }) as never,
        {} as never,
    );

    expect(res.status).toBeGreaterThanOrEqual(400);

    // The whole transaction must have rolled back.
    expect(await prisma.user.count({ where: { email } })).toBe(0);
    expect(await prisma.tenant.count({ where: { name: orgName } })).toBe(0);
    expect(
        await prisma.tenantMembership.count({ where: { tenant: { name: orgName } } }),
    ).toBe(0);
});

it('leaves the email free to retry after a failed attempt', async () => {
    const email = `retry-${randomUUID()}@example.com`;
    const orgName = `Retry Farms ${randomUUID()}`;

    induceTransactionFailure(prisma as unknown as PrismaClient);
    await POST(
        registerRequest({
            email, password: 'a-long-unbreached-passphrase-1', // pragma: allowlist secret
            name: 'Retry', orgName,
        }) as never,
        {} as never,
    );

    // Second attempt, no induced failure — must succeed, not 409.
    const res = await POST(
        registerRequest({
            email, password: 'a-long-unbreached-passphrase-1', // pragma: allowlist secret
            name: 'Retry', orgName,
        }) as never,
        {} as never,
    );

    expect(res.status).toBe(200);
});
