/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Unit tests for src/app-layer/usecases/audit-hardening.ts
 *
 * Wave 3 of GAP-02. The hardening surface is what makes audit packs
 * defensible: SHA-256 hashing of evidence files, ADMIN-gated immutable
 * export attachment, and pack cloning for retest workflows. A bug
 * here means either:
 *   - tampered evidence accepted as authentic (hash regression), or
 *   - non-ADMIN users freezing/sharing packs they should not (gate
 *     regression), or
 *   - retest packs cloning frozen FILE artefacts (corrupt audit chain).
 *
 * Behaviours protected:
 *   1. computeFileHash: deterministic SHA-256 across identical input.
 *   2. storeExportArtifact: ADMIN-only gate, rejects DRAFT pack,
 *      computes hash, persists AuditPackItem with sha256 in
 *      snapshotJson, emits AUDIT_EXPORT_GENERATED audit.
 *   3. clonePackForRetest: ADMIN/EDITOR gate, rejects DRAFT source,
 *      excludes FILE + READINESS_REPORT items from clone, auto-includes
 *      READY_FOR_RETEST tasks, emits AUDIT_PACK_CLONED + (if any
 *      retest issues) RETEST_REQUESTED audits.
 *   4. getAuditorAssignedPacks: AUDITOR-only; non-auditor → forbidden.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/lib/storage', () => ({
    getStorageProvider: jest.fn(),
    buildTenantObjectKey: jest.fn(
        (tenantId: string, prefix: string, filename: string) =>
            `${tenantId}/${prefix}/${filename}`,
    ),
}));

jest.mock('@/lib/prisma', () => ({
    prisma: {
        user: { findUnique: jest.fn() },
    },
}));

jest.mock('../../../src/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
    computeFileHash,
    storeExportArtifact,
    clonePackForRetest,
    getAuditorAssignedPacks,
} from '@/app-layer/usecases/audit-hardening';
import { runInTenantContext } from '@/lib/db-context';
import { prisma } from '@/lib/prisma';
import { logEvent } from '@/app-layer/events/audit';
import { getStorageProvider } from '@/lib/storage';
import { makeRequestContext } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockUserFindUnique = prisma.user.findUnique as jest.MockedFunction<typeof prisma.user.findUnique>;
const mockLog = logEvent as jest.MockedFunction<typeof logEvent>;
const mockGetStorage = getStorageProvider as jest.MockedFunction<typeof getStorageProvider>;

beforeEach(() => {
    // resetAllMocks() clears queued mockImplementationOnce entries
    // (clonePackForRetest tests chain 5–6 per test, leakage triggers
    // confusing "Cannot read properties of undefined" errors). It also
    // wipes the storage factory's default — re-prime it here.
    jest.resetAllMocks();
    mockGetStorage.mockReturnValue({
        readStream: jest.fn(),
        write: jest.fn().mockResolvedValue(undefined),
    } as never);
});

describe('computeFileHash', () => {
    it('returns SHA-256 hex deterministically across identical input', () => {
        const buf = Buffer.from('hello world', 'utf-8');
        const h1 = computeFileHash(buf);
        const h2 = computeFileHash(Buffer.from('hello world', 'utf-8'));
        expect(h1).toBe(h2);
        expect(h1).toMatch(/^[0-9a-f]{64}$/);
        // Regression: a refactor that swapped sha256→md5 or truncated
        // the hex would break evidence-integrity guarantees.
    });

    it('produces different hashes for different content', () => {
        const a = computeFileHash(Buffer.from('a'));
        const b = computeFileHash(Buffer.from('b'));
        expect(a).not.toBe(b);
    });
});

describe('storeExportArtifact', () => {
    function setupPack(pack: { id: string; status: string } | null) {
        mockRunInTx
            // First call — pack lookup
            .mockImplementationOnce(async () => pack as never)
            // Second call — auditPackItem.create
            .mockImplementationOnce(async (_ctx, fn) =>
                fn({
                    auditPackItem: { create: jest.fn().mockResolvedValue({}) },
                } as never),
            )
            // Third call — logEvent inside runInTenantContext wrapper
            .mockImplementationOnce(async (_ctx, fn) => fn({} as never));
    }

    it('rejects EDITOR — assertCanFreezePack is OWNER/ADMIN-only', async () => {
        // Matcher accepts both old ("Only ADMIN ...") and new ("Only OWNER
        // or ADMIN ...") forms — the test is about EDITOR being denied,
        // not the exact wording. Epic 1 added OWNER as a strict superset
        // of ADMIN, which extended the message accordingly.
        await expect(
            storeExportArtifact(
                makeRequestContext('EDITOR'),
                'p1',
                'content',
                'export.csv',
                'text/csv',
            ),
        ).rejects.toThrow(/(?:OWNER|ADMIN)/);
    });

    it('rejects READER and AUDITOR', async () => {
        await expect(
            storeExportArtifact(
                makeRequestContext('READER'), 'p1', 'c', 'f.csv', 'text/csv',
            ),
        ).rejects.toThrow();
        await expect(
            storeExportArtifact(
                makeRequestContext('AUDITOR'), 'p1', 'c', 'f.csv', 'text/csv',
            ),
        ).rejects.toThrow();
    });

    it('throws notFound when pack does not exist (cross-tenant id)', async () => {
        setupPack(null);
        await expect(
            storeExportArtifact(
                makeRequestContext('ADMIN'),
                'tenant-B-pack',
                'content',
                'export.csv',
                'text/csv',
            ),
        ).rejects.toThrow(/Pack not found/);
    });

    it('rejects attaching exports to a DRAFT pack', async () => {
        setupPack({ id: 'p1', status: 'DRAFT' });
        await expect(
            storeExportArtifact(
                makeRequestContext('ADMIN'),
                'p1',
                'content',
                'export.csv',
                'text/csv',
            ),
        ).rejects.toThrow(/DRAFT pack/);
        // Regression: a refactor that allowed export attachment to a
        // DRAFT pack would let an ADMIN swap an "approved" export AFTER
        // the pack was generated — breaking the immutability contract.
    });

    it('persists AuditPackItem with sha256 + size in snapshotJson and emits AUDIT_EXPORT_GENERATED', async () => {
        let capturedItemArgs: any;
        mockRunInTx
            .mockImplementationOnce(async () =>
                ({ id: 'p1', status: 'FROZEN' }) as never,
            )
            .mockImplementationOnce(async (_ctx, fn) =>
                fn({
                    auditPackItem: {
                        create: jest.fn().mockImplementation((args: any) => {
                            capturedItemArgs = args;
                            return Promise.resolve({});
                        }),
                    },
                } as never),
            )
            .mockImplementationOnce(async (_ctx, fn) => fn({} as never));

        const result = await storeExportArtifact(
            makeRequestContext('ADMIN'),
            'p1',
            'export-content',
            'audit-summary.csv',
            'text/csv',
        );

        const snap = JSON.parse(capturedItemArgs.data.snapshotJson);
        expect(snap.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(snap.size).toBe(Buffer.byteLength('export-content', 'utf-8'));
        expect(snap.originalFilename).toBe('audit-summary.csv');
        expect(snap.mimeType).toBe('text/csv');
        expect(result.hash).toBe(snap.sha256);

        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'AUDIT_EXPORT_GENERATED' }),
        );
    });
});

describe('clonePackForRetest', () => {
    it('rejects READER — assertCanManageAuditPacks is ADMIN/EDITOR', async () => {
        await expect(
            clonePackForRetest(makeRequestContext('READER'), 'src-pack'),
        ).rejects.toThrow();
    });

    it('rejects AUDITOR — auditors view but cannot clone', async () => {
        await expect(
            clonePackForRetest(makeRequestContext('AUDITOR'), 'src-pack'),
        ).rejects.toThrow();
    });

    it('throws notFound when source pack is missing', async () => {
        mockRunInTx.mockImplementationOnce(async () => null as never);

        await expect(
            clonePackForRetest(makeRequestContext('ADMIN'), 'missing'),
        ).rejects.toThrow(/Source pack not found/);
    });

    it('rejects cloning a DRAFT pack — must freeze first', async () => {
        mockRunInTx.mockImplementationOnce(async () =>
            ({ id: 'p1', status: 'DRAFT', items: [] }) as never,
        );

        await expect(
            clonePackForRetest(makeRequestContext('ADMIN'), 'p1'),
        ).rejects.toThrow(/freeze first/);
        // Regression: cloning a DRAFT pack would inherit non-canonical
        // selections that may have been edited mid-flight, defeating
        // the retest reproducibility goal.
    });

    it('excludes FILE + READINESS_REPORT items from the clone, auto-adds READY_FOR_RETEST issues, emits dual audit', async () => {
        const sourcePack = {
            id: 'src',
            status: 'FROZEN',
            auditCycleId: 'cyc-1',
            name: 'Q4 Pack',
            items: [
                { entityType: 'PRACTICE', entityId: 'c1', sortOrder: 1 },
                { entityType: 'FILE', entityId: 'f1', sortOrder: 2 },
                { entityType: 'READINESS_REPORT', entityId: 'rep1', sortOrder: 3 },
                { entityType: 'EVIDENCE', entityId: 'e1', sortOrder: 4 },
            ],
        };
        let createManyArgs: any;

        mockRunInTx
            // 1. source pack lookup
            .mockImplementationOnce(async () => sourcePack as never)
            // 2. clonedPack create
            .mockImplementationOnce(async (_ctx, fn) =>
                fn({
                    auditPack: {
                        create: jest.fn().mockResolvedValue({
                            id: 'clone-1',
                            auditCycleId: 'cyc-1',
                            name: 'Retest: Q4 Pack',
                        }),
                    },
                } as never),
            )
            // 3. retest issues
            .mockImplementationOnce(async (_ctx, fn) =>
                fn({
                    task: {
                        findMany: jest.fn().mockResolvedValue([
                            { id: 'task-1' },
                            { id: 'task-2' },
                        ]),
                    },
                } as never),
            )
            // 4. createMany items
            .mockImplementationOnce(async (_ctx, fn) =>
                fn({
                    auditPackItem: {
                        createMany: jest.fn().mockImplementation((args: any) => {
                            createManyArgs = args;
                            return Promise.resolve({ count: args.data.length });
                        }),
                    },
                } as never),
            )
            // 5. AUDIT_PACK_CLONED log
            .mockImplementationOnce(async (_ctx, fn) => fn({} as never))
            // 6. RETEST_REQUESTED log
            .mockImplementationOnce(async (_ctx, fn) => fn({} as never));

        await clonePackForRetest(makeRequestContext('ADMIN'), 'src');

        const cloned = createManyArgs.data;
        const types = cloned.map((i: any) => i.entityType);
        // Regression: a refactor that allowed FILE / READINESS_REPORT
        // items to flow through would re-attach STALE artefacts to the
        // retest pack — corrupting the snapshot guarantee that the
        // retest is a fresh capture.
        expect(types).not.toContain('FILE');
        expect(types).not.toContain('READINESS_REPORT');
        expect(types).toContain('PRACTICE');
        expect(types).toContain('EVIDENCE');
        expect(types).toContain('ISSUE'); // auto-added retest issue

        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'AUDIT_PACK_CLONED' }),
        );
        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'RETEST_REQUESTED' }),
        );
    });

    it('skips RETEST_REQUESTED audit when there are zero READY_FOR_RETEST issues', async () => {
        mockRunInTx
            .mockImplementationOnce(async () =>
                ({
                    id: 'src',
                    status: 'FROZEN',
                    auditCycleId: 'cyc-1',
                    name: 'Q4',
                    items: [{ entityType: 'PRACTICE', entityId: 'c1', sortOrder: 1 }],
                }) as never,
            )
            .mockImplementationOnce(async (_ctx, fn) =>
                fn({
                    auditPack: {
                        create: jest.fn().mockResolvedValue({
                            id: 'clone-1', name: 'Retest: Q4',
                        }),
                    },
                } as never),
            )
            .mockImplementationOnce(async (_ctx, fn) =>
                fn({ task: { findMany: jest.fn().mockResolvedValue([]) } } as never),
            )
            .mockImplementationOnce(async (_ctx, fn) =>
                fn({ auditPackItem: { createMany: jest.fn().mockResolvedValue({ count: 1 }) } } as never),
            )
            .mockImplementationOnce(async (_ctx, fn) => fn({} as never)); // PACK_CLONED only

        await clonePackForRetest(makeRequestContext('ADMIN'), 'src');

        const calls = mockLog.mock.calls.map((c: any[]) => c[2].action);
        expect(calls).toContain('AUDIT_PACK_CLONED');
        expect(calls).not.toContain('RETEST_REQUESTED');
    });
});

describe('getAuditorAssignedPacks', () => {
    it('rejects ADMIN — auditor-only view', async () => {
        await expect(
            getAuditorAssignedPacks(makeRequestContext('ADMIN')),
        ).rejects.toThrow(/Only auditors/);
        // Regression: an admin could otherwise impersonate the auditor
        // view and pull a list of every external auditor's pack
        // assignments.
    });

    it('rejects EDITOR + READER', async () => {
        await expect(
            getAuditorAssignedPacks(makeRequestContext('EDITOR')),
        ).rejects.toThrow();
        await expect(
            getAuditorAssignedPacks(makeRequestContext('READER')),
        ).rejects.toThrow();
    });

    it('returns [] when the user has no email row (placeholder mid-onboarding)', async () => {
        mockUserFindUnique.mockResolvedValueOnce(null);
        const result = await getAuditorAssignedPacks(
            makeRequestContext('AUDITOR'),
        );
        expect(result).toEqual([]);
    });

    it('returns [] when the user has no AuditorAccount in this tenant', async () => {
        mockUserFindUnique.mockResolvedValueOnce({ email: 'a@b.com' } as never);
        mockRunInTx.mockImplementationOnce(async () => null as never);

        const result = await getAuditorAssignedPacks(
            makeRequestContext('AUDITOR'),
        );
        expect(result).toEqual([]);
    });
});
