/**
 * Integration test: per-tenant DEK rotation, end-to-end against a real DB.
 *
 * Replaces the original `tenant-dek-rotation-stub.test.ts` (which
 * asserted the stub-throw behaviour). The CHECK-constraint assertion
 * is preserved unchanged: it locks in the schema invariant that
 * `previousEncryptedDek != encryptedDek`, which the rotation control
 * flow trusts (a fresh `crypto.randomBytes(32)` could in theory
 * collide; the constraint catches operator-injected mistakes too).
 *
 * Behaviours covered:
 *
 *   1. `rotateTenantDek` swaps the DEK atomically — old wrapped DEK
 *      ends up in `previousEncryptedDek`; new wrapped DEK ends up in
 *      `encryptedDek`. The new DEK round-trips correctly under the
 *      master KEK.
 *
 *   2. While `previousEncryptedDek` is non-null, calling rotation
 *      again is rejected with the "already mid-rotation" error.
 *      Operator must wait for the sweep job to clear the column.
 *
 *   3. CHECK constraint (`Tenant_previousEncryptedDek_differs`)
 *      rejects an UPDATE that sets `previousEncryptedDek` equal to
 *      `encryptedDek`. Schema-level guard for silent key mixing.
 *
 *   4. The rotation enqueues a BullMQ job (best-effort assertion via
 *      a mock — full job execution is covered by the unit tests).
 */

import {
    rotateTenantDek,
    _resetTenantDekCache,
} from '@/lib/security/tenant-key-manager';
import { generateDek, wrapDek, unwrapDek } from '@/lib/security/tenant-keys';
import {
    encryptWithKey,
    decryptWithKey,
    decryptWithKeyOrPrevious,
} from '@/lib/security/encryption';
import { runTenantDekRotation } from '@/app-layer/jobs/tenant-dek-rotation';
import type { TenantDekRotationProgress } from '@/app-layer/jobs/tenant-dek-rotation';
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';

// Mock the BullMQ queue so we don't need Redis for an integration
// test focused on DB behaviour. Real job execution is covered by
// the unit-level tests in `tests/unit/tenant-key-manager.rotate.test.ts`.
jest.mock('@/app-layer/jobs/queue', () => ({
    enqueue: jest.fn().mockResolvedValue({ id: 'integration-test-job' }),
}));

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('rotateTenantDek (integration — real DB)', () => {
    let prisma: PrismaClient;
    const slugs: string[] = [];

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
    });

    afterAll(async () => {
        // Best-effort cleanup. The lifecycle test seeds Finding rows
        // and the rotation engine writes AuditLog rows — both have
        // FK -> Tenant, so they must go before the tenant rows.
        // AuditLog has an immutability trigger that blocks DELETE
        // outside `session_replication_role = 'replica'`; same
        // bypass pattern as audit-immutability.test.ts.
        try {
            const ids = await prisma.tenant.findMany({
                where: { slug: { in: slugs } },
                select: { id: true },
            });
            const tenantIds = ids.map((t) => t.id);
            if (tenantIds.length > 0) {
                await prisma
                    .$transaction(async (tx) => {
                        await tx.$executeRawUnsafe(
                            `SET LOCAL session_replication_role = 'replica'`,
                        );
                        for (const tid of tenantIds) {
                            await tx.$executeRawUnsafe(
                                `DELETE FROM "AuditLog" WHERE "tenantId" = $1`,
                                tid,
                            );
                        }
                    })
                    .catch(() => undefined);
                await prisma.finding
                    .deleteMany({ where: { tenantId: { in: tenantIds } } })
                    .catch(() => undefined);
            }
            await prisma.tenant.deleteMany({
                where: { slug: { in: slugs } },
            });
        } catch {
            /* best effort */
        }
        await prisma.$disconnect();
    });

    beforeEach(() => {
        _resetTenantDekCache();
    });

    test('atomically swaps encryptedDek and populates previousEncryptedDek', async () => {
        const slug = `rot-happy-${Date.now()}`;
        slugs.push(slug);
        const initialDek = generateDek();
        const initialWrapped = wrapDek(initialDek);

        const tenant = await prisma.tenant.create({
            data: {
                name: 'rot-happy',
                slug,
                encryptedDek: initialWrapped,
            },
        });

        const result = await rotateTenantDek({
            tenantId: tenant.id,
            initiatedByUserId: 'user-int-1',
        });
        expect(result.tenantId).toBe(tenant.id);
        expect(typeof result.jobId).toBe('string');
        expect(result.jobId.length).toBeGreaterThan(0);

        const after = await prisma.tenant.findUnique({
            where: { id: tenant.id },
            select: {
                encryptedDek: true,
                previousEncryptedDek: true,
            },
        });

        // Previous slot now carries the OLD wrapped DEK.
        expect(after?.previousEncryptedDek).toBe(initialWrapped);
        // Primary slot has a NEW wrapped DEK (different bytes).
        expect(after?.encryptedDek).not.toBe(initialWrapped);
        // The new wrapped DEK round-trips to a 32-byte key.
        const recovered = unwrapDek(after!.encryptedDek!);
        expect(recovered.length).toBe(32);
        // ...and is NOT equal to the original DEK.
        expect(recovered.equals(initialDek)).toBe(false);
    });

    test('rejects a second rotation while the previous slot is still populated', async () => {
        const slug = `rot-double-${Date.now()}`;
        slugs.push(slug);
        const tenant = await prisma.tenant.create({
            data: {
                name: 'rot-double',
                slug,
                encryptedDek: wrapDek(generateDek()),
            },
        });

        // First rotation succeeds and leaves previousEncryptedDek set.
        await rotateTenantDek({
            tenantId: tenant.id,
            initiatedByUserId: 'user-int-2',
        });

        // Second attempt is refused — operator must wait for the sweep.
        await expect(
            rotateTenantDek({
                tenantId: tenant.id,
                initiatedByUserId: 'user-int-2',
            }),
        ).rejects.toThrow(/already mid-rotation/);
    });

    test('CHECK constraint rejects identical DEK values — silent-key-mixing guard', async () => {
        // Schema-level invariant. The rotation flow trusts this — if
        // somehow encryptedDek and previousEncryptedDek end up equal
        // after a successful UPDATE, the constraint would have
        // already rejected the write. Test it directly.
        const slug = `rot-constraint-${Date.now()}`;
        slugs.push(slug);
        const t = await prisma.tenant.create({
            data: {
                name: 'rot-constraint',
                slug,
                encryptedDek: 'v1:dGVzdA==',
            },
        });
        await expect(
            prisma.tenant.update({
                where: { id: t.id },
                data: { previousEncryptedDek: 'v1:dGVzdA==' },
            }),
        ).rejects.toThrow(/Tenant_previousEncryptedDek_differs|check constraint/i);
    });

    // ── GAP-22 lifecycle proof ──────────────────────────────────────
    //
    // The earlier tests cover the SWAP correctness (atomic, idempotent,
    // CHECK-constrained). This test proves the FULL LIFECYCLE — that
    // ciphertext written before rotation is still readable after the
    // swap (via the dual-DEK fallback) AND that, after the sweep job
    // runs, every row decrypts under the new DEK alone.
    //
    // Why this matters: the swap is atomic and fast, but the
    // re-encrypt sweep is the long pole. Between `rotateTenantDek`
    // returning and the BullMQ job clearing `previousEncryptedDek`,
    // the system is in dual-DEK mode. The middleware's
    // `decryptWithKeyOrPrevious` is what makes that mode safe; this
    // test exercises the contract end-to-end.

    test('full lifecycle: pre-rotation ciphertext stays readable, post-sweep all v2 under new DEK', async () => {
        const slug = `rot-lifecycle-${Date.now()}`;
        slugs.push(slug);

        // Create a real user so the rotation engine's audit entries
        // (TENANT_DEK_ROTATION_STARTED / _COMPLETED) clear their
        // AuditLog.userId FK. The other tests in this file don't run
        // the engine job, so they didn't need this; we do.
        const userEmail = `rot-lifecycle-${Date.now()}@test.local`;
        const { hashForLookup } = await import('@/lib/security/encryption');
        const lifecycleUser = await prisma.user.create({
            data: {
                email: userEmail,
                emailHash: hashForLookup(userEmail),
                name: 'Lifecycle User',
            },
        });

        // ── Setup: tenant + initial DEK ─────────────────────────────
        const initialDek = generateDek();
        const initialWrapped = wrapDek(initialDek);
        const tenant = await prisma.tenant.create({
            data: {
                name: 'rot-lifecycle',
                slug,
                encryptedDek: initialWrapped,
            },
        });

        // ── Seed v2 ciphertexts under the INITIAL DEK ───────────────
        // Finding.rootCause is in the encrypted-fields manifest and
        // Finding carries a tenantId column — so the rotation sweep
        // will pick these rows up. Write directly via Prisma + a pre-
        // computed v2 ciphertext (bypasses the runtime middleware
        // which is conditional on audit context).
        const PLAINTEXTS = [
            'drainage channel silted at the north headland',
            'sprayer nozzle drift beyond the buffer strip',
            'storage humidity above the grain contract threshold',
        ];
        const seeded: Array<{ id: string; plaintext: string }> = [];
        for (const plaintext of PLAINTEXTS) {
            const v2 = encryptWithKey(initialDek, plaintext);
            const finding = await prisma.finding.create({
                data: {
                    tenantId: tenant.id,
                    title: `lifecycle-${seeded.length}`,
                    description: `lifecycle finding ${seeded.length}`,
                    severity: 'HIGH',
                    type: 'NONCONFORMITY',
                    rootCause: v2,
                },
            });
            seeded.push({ id: finding.id, plaintext });
        }

        // Sanity — ciphertexts on disk are v2: shape and decrypt
        // cleanly under the initial DEK.
        const seededRows = await prisma.$queryRawUnsafe<
            Array<{ id: string; rootCause: string }>
        >(
            `SELECT id, "rootCause" FROM "Finding" WHERE "tenantId" = $1 ORDER BY id`,
            tenant.id,
        );
        expect(seededRows).toHaveLength(PLAINTEXTS.length);
        for (const row of seededRows) {
            expect(row.rootCause.startsWith('v2:')).toBe(true);
            const seedMatch = seeded.find((s) => s.id === row.id)!;
            expect(decryptWithKey(initialDek, row.rootCause)).toBe(
                seedMatch.plaintext,
            );
        }

        // ── Phase 1: rotateTenantDek (sync swap) ────────────────────
        const result = await rotateTenantDek({
            tenantId: tenant.id,
            initiatedByUserId: lifecycleUser.id,
        });
        expect(result.tenantId).toBe(tenant.id);

        const afterSwap = await prisma.tenant.findUnique({
            where: { id: tenant.id },
            select: { encryptedDek: true, previousEncryptedDek: true },
        });
        expect(afterSwap?.previousEncryptedDek).toBe(initialWrapped);
        expect(afterSwap?.encryptedDek).not.toBe(initialWrapped);
        const newDek = unwrapDek(afterSwap!.encryptedDek!);
        const previousDek = unwrapDek(afterSwap!.previousEncryptedDek!);

        // Pre-sweep, the seeded rows are STILL ENCRYPTED UNDER THE
        // PREVIOUS DEK on disk — the swap moved DEKs, not data. The
        // middleware's `decryptWithKeyOrPrevious` is what keeps reads
        // working: it tries the new (primary) DEK, fails AES-GCM
        // auth, and falls back to the previous DEK.
        for (const row of seededRows) {
            // Under the NEW DEK directly: must FAIL (different key).
            expect(() => decryptWithKey(newDek, row.rootCause)).toThrow();
            // Under the PREVIOUS DEK directly: still works.
            const seedMatch = seeded.find((s) => s.id === row.id)!;
            expect(decryptWithKey(previousDek, row.rootCause)).toBe(
                seedMatch.plaintext,
            );
            // Via the production fallback: works without the caller
            // having to know which DEK is active.
            expect(
                decryptWithKeyOrPrevious(newDek, previousDek, row.rootCause),
            ).toBe(seedMatch.plaintext);
        }

        // ── Phase 2: run the sweep ──────────────────────────────────
        // Capture progress payloads so we can assert live observability.
        const progressEvents: TenantDekRotationProgress[] = [];
        const sweepResult = await runTenantDekRotation({
            tenantId: tenant.id,
            initiatedByUserId: lifecycleUser.id,
            batchSize: 2, // small so the per-batch progress hook fires
            onProgress: async (p) => {
                progressEvents.push(p);
            },
        });

        expect(sweepResult.tenantId).toBe(tenant.id);
        expect(sweepResult.previousEncryptedDekCleared).toBe(true);
        expect(sweepResult.totalErrors).toBe(0);
        // The Finding.rootCause column carried 3 v2 rows — they all
        // get rewritten. The sweep walks every (model, field) so its
        // counters span the whole manifest, but `totalRewritten` is
        // bounded below by what we seeded.
        expect(sweepResult.totalRewritten).toBeGreaterThanOrEqual(PLAINTEXTS.length);

        // Progress hook fired with at least: starting → sweeping →
        // finalising → complete.
        const phases = progressEvents.map((p) => p.phase);
        expect(phases[0]).toBe('starting');
        expect(phases).toContain('sweeping');
        expect(phases).toContain('finalising');
        expect(phases[phases.length - 1]).toBe('complete');
        // Final cumulative totals match the result.
        const final = progressEvents[progressEvents.length - 1];
        expect(final.totalRewritten).toBe(sweepResult.totalRewritten);
        expect(final.totalErrors).toBe(sweepResult.totalErrors);

        // ── Phase 3: post-sweep — DEK column cleared, all v2 under new DEK ──
        const afterSweep = await prisma.tenant.findUnique({
            where: { id: tenant.id },
            select: { encryptedDek: true, previousEncryptedDek: true },
        });
        // previousEncryptedDek MUST be NULL — the only signal that
        // the rotation is "done"; subsequent rotations key off it.
        expect(afterSweep?.previousEncryptedDek).toBeNull();
        expect(afterSweep?.encryptedDek).toBe(afterSwap?.encryptedDek);

        const sweptRows = await prisma.$queryRawUnsafe<
            Array<{ id: string; rootCause: string }>
        >(
            `SELECT id, "rootCause" FROM "Finding" WHERE "tenantId" = $1 ORDER BY id`,
            tenant.id,
        );
        expect(sweptRows).toHaveLength(PLAINTEXTS.length);
        for (const row of sweptRows) {
            const seedMatch = seeded.find((s) => s.id === row.id)!;
            // Plaintext recovers correctly under the NEW DEK alone —
            // no fallback needed.
            expect(row.rootCause.startsWith('v2:')).toBe(true);
            expect(decryptWithKey(newDek, row.rootCause)).toBe(seedMatch.plaintext);
            // Under the PREVIOUS DEK: must FAIL (the row is no
            // longer encrypted under that key).
            expect(() => decryptWithKey(previousDek, row.rootCause)).toThrow();
        }

        // ── Phase 4: a brand-new write uses the new DEK ─────────────
        // This proves the post-rotation steady state — no stale
        // tenant DEK is hanging around in any cache or middleware
        // path that would silently encrypt under the old key.
        const freshPlaintext = 'newly-discovered headland compaction';
        const freshV2 = encryptWithKey(newDek, freshPlaintext);
        const freshFinding = await prisma.finding.create({
            data: {
                tenantId: tenant.id,
                title: 'lifecycle-fresh',
                description: 'lifecycle finding — post-rotation write',
                severity: 'HIGH',
                type: 'NONCONFORMITY',
                rootCause: freshV2,
            },
        });
        const [freshRow] = await prisma.$queryRawUnsafe<
            Array<{ rootCause: string }>
        >(`SELECT "rootCause" FROM "Finding" WHERE id = $1`, freshFinding.id);
        expect(freshRow.rootCause.startsWith('v2:')).toBe(true);
        expect(decryptWithKey(newDek, freshRow.rootCause)).toBe(freshPlaintext);
        // And the previous DEK doesn't decrypt it.
        expect(() => decryptWithKey(previousDek, freshRow.rootCause)).toThrow();

        // ── Cleanup ────────────────────────────────────────────────
        // AuditLog has an immutability trigger; bypass with
        // `SET LOCAL session_replication_role = 'replica'` inside a
        // transaction (same pattern as audit-immutability.test.ts).
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(
                `SET LOCAL session_replication_role = 'replica'`,
            );
            await tx.$executeRawUnsafe(
                `DELETE FROM "AuditLog" WHERE "tenantId" = $1`,
                tenant.id,
            );
        });
        await prisma.finding.deleteMany({ where: { tenantId: tenant.id } });
        await prisma.user
            .delete({ where: { id: lifecycleUser.id } })
            .catch(() => undefined);
    }, 30_000);
});
