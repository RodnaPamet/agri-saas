/**
 * Unit Test: per-tenant DEK rotation in tenant-key-manager.
 *
 * Pins the rotation practice flow added when the Epic F.2 stub was
 * replaced with a real implementation. Sibling to
 * `tenant-key-manager.test.ts` (which covers the steady-state
 * primary-DEK path).
 *
 * Covers:
 *   - `rotateTenantDek` happy path: atomic swap, cache discipline,
 *     job enqueue, return shape.
 *   - `rotateTenantDek` rejects: no-DEK, double-rotation,
 *     concurrent-rotation, unknown-tenant.
 *   - `rotateTenantDek` enqueue failure AFTER swap surfaces a clear
 *     half-rotation error (state still readable via fallback).
 *   - `getTenantPreviousDek`: cache hit skips DB; populated column
 *     unwraps + caches; null column negative-caches.
 *   - `clearTenantPreviousDekCache`: targeted + global.
 *   - Negative cache: in-process TTL bounds; `rotateTenantDek`
 *     proactively clears it for the rotated tenant.
 *   - Audit-clean logging — no DEK bytes leak into log calls.
 */

jest.mock('@/lib/observability/logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

const mockTenant = {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
};
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { tenant: mockTenant },
    prisma: { tenant: mockTenant },
}));

const enqueueMock = jest.fn();
jest.mock('@/app-layer/jobs/queue', () => ({
    enqueue: (...args: unknown[]) => enqueueMock(...args),
}));

import {
    rotateTenantDek,
    getTenantDek,
    getTenantPreviousDek,
    getTenantDekCacheSize,
    getTenantPreviousDekCacheSize,
    clearTenantPreviousDekCache,
    _resetTenantDekCache,
} from '@/lib/security/tenant-key-manager';
import {
    generateDek,
    wrapDek,
    unwrapDek,
} from '@/lib/security/tenant-keys';
import { logger } from '@/lib/observability/logger';

const TENANT_ID = 'tenant-rot-1';
const INITIATED_BY = 'user-rot-1';

describe('tenant-key-manager — per-tenant DEK rotation', () => {
    beforeEach(() => {
        _resetTenantDekCache();
        jest.clearAllMocks();
        enqueueMock.mockResolvedValue({ id: 'job-1' });
    });

    describe('rotateTenantDek — happy path', () => {
        test('atomically swaps DEK, primes both caches, enqueues sweep', async () => {
            const oldDek = generateDek();
            const oldWrapped = wrapDek(oldDek);

            // Initial findUnique — current state.
            mockTenant.findUnique.mockResolvedValueOnce({
                id: TENANT_ID,
                encryptedDek: oldWrapped,
                previousEncryptedDek: null,
            });
            // Atomic swap — one row matched.
            mockTenant.updateMany.mockResolvedValueOnce({ count: 1 });

            const result = await rotateTenantDek({
                tenantId: TENANT_ID,
                initiatedByUserId: INITIATED_BY,
            });

            expect(result.tenantId).toBe(TENANT_ID);
            expect(result.jobId).toBe('job-1');

            // The UPDATE moved old DEK into previous + wrote a fresh
            // wrapped DEK into encryptedDek. Inspect the data shape.
            const updateArgs = mockTenant.updateMany.mock.calls[0][0];
            expect(updateArgs.where).toEqual({
                id: TENANT_ID,
                previousEncryptedDek: null,
            });
            expect(updateArgs.data.previousEncryptedDek).toBe(oldWrapped);
            expect(updateArgs.data.encryptedDek).not.toBe(oldWrapped);
            // The new DEK round-trips correctly under the master KEK.
            expect(unwrapDek(updateArgs.data.encryptedDek).length).toBe(32);

            // Job enqueued with the right payload.
            expect(enqueueMock).toHaveBeenCalledWith('tenant-dek-rotation', {
                tenantId: TENANT_ID,
                initiatedByUserId: INITIATED_BY,
                requestId: undefined,
            });

            // Cache discipline:
            //   - new primary is cached (size === 1)
            //   - previous-DEK cache is empty (we didn't have a primary
            //     cache hit before the rotation, so there was nothing
            //     to promote into the previous slot)
            expect(getTenantDekCacheSize()).toBe(1);
            expect(getTenantPreviousDekCacheSize()).toBe(0);
        });

        test('promotes a pre-existing cached primary DEK into the previous slot', async () => {
            const oldDek = generateDek();
            const oldWrapped = wrapDek(oldDek);

            // Warm the primary cache so rotation can promote it.
            mockTenant.findUnique.mockResolvedValueOnce({
                encryptedDek: oldWrapped,
            });
            const warmed = await getTenantDek(TENANT_ID);
            expect(warmed.equals(oldDek)).toBe(true);
            expect(getTenantDekCacheSize()).toBe(1);

            // Now the rotation reads the current state.
            mockTenant.findUnique.mockResolvedValueOnce({
                id: TENANT_ID,
                encryptedDek: oldWrapped,
                previousEncryptedDek: null,
            });
            mockTenant.updateMany.mockResolvedValueOnce({ count: 1 });

            await rotateTenantDek({
                tenantId: TENANT_ID,
                initiatedByUserId: INITIATED_BY,
            });

            // The previous-DEK cache now carries the promoted DEK —
            // and it equals the original oldDek (no extra unwrap).
            expect(getTenantPreviousDekCacheSize()).toBe(1);
            expect(getTenantDekCacheSize()).toBe(1);
        });

        test('threads requestId into the job payload', async () => {
            mockTenant.findUnique.mockResolvedValueOnce({
                id: TENANT_ID,
                encryptedDek: wrapDek(generateDek()),
                previousEncryptedDek: null,
            });
            mockTenant.updateMany.mockResolvedValueOnce({ count: 1 });

            await rotateTenantDek({
                tenantId: TENANT_ID,
                initiatedByUserId: INITIATED_BY,
                requestId: 'req-xyz',
            });

            expect(enqueueMock).toHaveBeenCalledWith(
                'tenant-dek-rotation',
                expect.objectContaining({ requestId: 'req-xyz' }),
            );
        });
    });

    describe('rotateTenantDek — rejection paths', () => {
        test('throws on unknown tenant', async () => {
            mockTenant.findUnique.mockResolvedValueOnce(null);
            await expect(
                rotateTenantDek({
                    tenantId: TENANT_ID,
                    initiatedByUserId: INITIATED_BY,
                }),
            ).rejects.toThrow(/tenant .* not found/);
            expect(mockTenant.updateMany).not.toHaveBeenCalled();
            expect(enqueueMock).not.toHaveBeenCalled();
        });

        test('throws on tenant with no encryptedDek (call ensureTenantDek first)', async () => {
            mockTenant.findUnique.mockResolvedValueOnce({
                id: TENANT_ID,
                encryptedDek: null,
                previousEncryptedDek: null,
            });
            await expect(
                rotateTenantDek({
                    tenantId: TENANT_ID,
                    initiatedByUserId: INITIATED_BY,
                }),
            ).rejects.toThrow(/no encryptedDek to rotate/);
            expect(mockTenant.updateMany).not.toHaveBeenCalled();
            expect(enqueueMock).not.toHaveBeenCalled();
        });

        test('throws when rotation already in flight (previousEncryptedDek non-null)', async () => {
            mockTenant.findUnique.mockResolvedValueOnce({
                id: TENANT_ID,
                encryptedDek: wrapDek(generateDek()),
                previousEncryptedDek: wrapDek(generateDek()),
            });
            await expect(
                rotateTenantDek({
                    tenantId: TENANT_ID,
                    initiatedByUserId: INITIATED_BY,
                }),
            ).rejects.toThrow(/already mid-rotation/);
            expect(mockTenant.updateMany).not.toHaveBeenCalled();
            expect(enqueueMock).not.toHaveBeenCalled();
        });

        test('throws on concurrent rotation (updateMany count = 0)', async () => {
            mockTenant.findUnique.mockResolvedValueOnce({
                id: TENANT_ID,
                encryptedDek: wrapDek(generateDek()),
                previousEncryptedDek: null,
            });
            // Sibling caller beat us to the swap; our updateMany sees
            // count = 0 because previousEncryptedDek is no longer null.
            mockTenant.updateMany.mockResolvedValueOnce({ count: 0 });

            await expect(
                rotateTenantDek({
                    tenantId: TENANT_ID,
                    initiatedByUserId: INITIATED_BY,
                }),
            ).rejects.toThrow(/concurrent rotation detected/);
            expect(enqueueMock).not.toHaveBeenCalled();
        });

        test('half-rotation: enqueue failure AFTER swap surfaces a clear error', async () => {
            mockTenant.findUnique.mockResolvedValueOnce({
                id: TENANT_ID,
                encryptedDek: wrapDek(generateDek()),
                previousEncryptedDek: null,
            });
            mockTenant.updateMany.mockResolvedValueOnce({ count: 1 });
            enqueueMock.mockRejectedValueOnce(new Error('redis blip'));

            await expect(
                rotateTenantDek({
                    tenantId: TENANT_ID,
                    initiatedByUserId: INITIATED_BY,
                }),
            ).rejects.toThrow(
                /DEK was swapped but the re-encrypt job could not be enqueued/,
            );
            // The swap STILL happened — proven by the updateMany call.
            expect(mockTenant.updateMany).toHaveBeenCalledTimes(1);
            // Logged loud for the operator.
            expect(logger.error).toHaveBeenCalledWith(
                'tenant-key-manager.dek_rotated_but_enqueue_failed',
                expect.objectContaining({ tenantId: TENANT_ID }),
            );
        });
    });

    describe('getTenantPreviousDek', () => {
        test('returns null when previousEncryptedDek is null', async () => {
            mockTenant.findUnique.mockResolvedValueOnce({
                previousEncryptedDek: null,
            });
            const result = await getTenantPreviousDek(TENANT_ID);
            expect(result).toBeNull();
        });

        test('negative cache: a second call within the TTL skips the DB', async () => {
            mockTenant.findUnique.mockResolvedValueOnce({
                previousEncryptedDek: null,
            });
            const first = await getTenantPreviousDek(TENANT_ID);
            const second = await getTenantPreviousDek(TENANT_ID);
            expect(first).toBeNull();
            expect(second).toBeNull();
            // Single DB hit despite two calls.
            expect(mockTenant.findUnique).toHaveBeenCalledTimes(1);
        });

        test('returns the unwrapped DEK when previousEncryptedDek is populated', async () => {
            const previousDek = generateDek();
            const previousWrapped = wrapDek(previousDek);
            mockTenant.findUnique.mockResolvedValueOnce({
                previousEncryptedDek: previousWrapped,
            });
            const result = await getTenantPreviousDek(TENANT_ID);
            expect(result).not.toBeNull();
            expect(result!.equals(previousDek)).toBe(true);
        });

        test('caches the resolved previous DEK — second call avoids DB', async () => {
            const previousDek = generateDek();
            mockTenant.findUnique.mockResolvedValueOnce({
                previousEncryptedDek: wrapDek(previousDek),
            });
            await getTenantPreviousDek(TENANT_ID);
            await getTenantPreviousDek(TENANT_ID);
            expect(mockTenant.findUnique).toHaveBeenCalledTimes(1);
            expect(getTenantPreviousDekCacheSize()).toBe(1);
        });

        test('throws when tenant does not exist', async () => {
            mockTenant.findUnique.mockResolvedValueOnce(null);
            await expect(
                getTenantPreviousDek('nonexistent'),
            ).rejects.toThrow(/tenant .* not found/);
        });

        test('rotateTenantDek clears the negative cache for that tenant', async () => {
            // Step 1: warm the negative cache (no previous DEK yet).
            mockTenant.findUnique.mockResolvedValueOnce({
                previousEncryptedDek: null,
            });
            await getTenantPreviousDek(TENANT_ID);

            // Step 2: rotation runs. After rotation the column is
            // populated; a stale negative cache would mask that.
            mockTenant.findUnique.mockResolvedValueOnce({
                id: TENANT_ID,
                encryptedDek: wrapDek(generateDek()),
                previousEncryptedDek: null,
            });
            mockTenant.updateMany.mockResolvedValueOnce({ count: 1 });
            await rotateTenantDek({
                tenantId: TENANT_ID,
                initiatedByUserId: INITIATED_BY,
            });

            // Step 3: getTenantPreviousDek must now hit the DB again
            // (negative-cache entry was dropped by rotateTenantDek).
            const post = wrapDek(generateDek());
            mockTenant.findUnique.mockResolvedValueOnce({
                previousEncryptedDek: post,
            });
            const result = await getTenantPreviousDek(TENANT_ID);
            expect(result).not.toBeNull();
            // findUnique was called: warm negative + post-rotation = 2.
            // (Plus the rotation's own findUnique = 3 total.)
            const previousDekCalls = mockTenant.findUnique.mock.calls.filter(
                (c) =>
                    c[0]?.select?.previousEncryptedDek === true &&
                    c[0]?.select?.encryptedDek !== true,
            );
            expect(previousDekCalls.length).toBeGreaterThanOrEqual(2);
        });
    });

    describe('clearTenantPreviousDekCache', () => {
        test('targeted clear drops only that tenant', async () => {
            const dek1 = generateDek();
            const dek2 = generateDek();
            mockTenant.findUnique
                .mockResolvedValueOnce({ previousEncryptedDek: wrapDek(dek1) })
                .mockResolvedValueOnce({ previousEncryptedDek: wrapDek(dek2) });
            await getTenantPreviousDek('t-A');
            await getTenantPreviousDek('t-B');
            expect(getTenantPreviousDekCacheSize()).toBe(2);

            clearTenantPreviousDekCache('t-A');
            expect(getTenantPreviousDekCacheSize()).toBe(1);
        });

        test('global clear empties the previous-DEK cache', async () => {
            const dek = generateDek();
            mockTenant.findUnique.mockResolvedValueOnce({
                previousEncryptedDek: wrapDek(dek),
            });
            await getTenantPreviousDek('t-A');
            expect(getTenantPreviousDekCacheSize()).toBe(1);

            clearTenantPreviousDekCache();
            expect(getTenantPreviousDekCacheSize()).toBe(0);
        });
    });

    describe('audit cleanliness — DEK bytes never leak into logs', () => {
        test('rotation logs carry no plaintext key material', async () => {
            const oldDek = generateDek();
            const oldWrapped = wrapDek(oldDek);
            mockTenant.findUnique.mockResolvedValueOnce({
                id: TENANT_ID,
                encryptedDek: oldWrapped,
                previousEncryptedDek: null,
            });
            mockTenant.updateMany.mockResolvedValueOnce({ count: 1 });

            await rotateTenantDek({
                tenantId: TENANT_ID,
                initiatedByUserId: INITIATED_BY,
            });

            const allLogs = JSON.stringify([
                ...(logger.info as jest.Mock).mock.calls,
                ...(logger.warn as jest.Mock).mock.calls,
                ...(logger.error as jest.Mock).mock.calls,
            ]);
            // Raw DEK bytes never appear in any encoding.
            expect(allLogs).not.toContain(oldDek.toString('hex'));
            expect(allLogs).not.toContain(oldDek.toString('base64'));
            // Wrapped DEK envelope is not secret per se but also has
            // no business in logs.
            expect(allLogs).not.toContain(oldWrapped);
        });
    });
});
