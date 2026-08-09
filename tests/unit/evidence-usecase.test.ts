/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks
 * mirror runtime Prisma/repo contracts; per-line typing has poor
 * cost/benefit ratio in test files (same standard pattern as
 * tests/unit/practice-applicability.test.ts). */

/**
 * Unit tests for `src/app-layer/usecases/evidence.ts`.
 *
 * Targeted by `docs/test-coverage-roadmap.md` Q1 — Evidence + files.
 * Mocks the repository seam (`EvidenceRepository`), the cache layer
 * (`cachedListRead` / `bumpEntityCacheVersion`), the audit emitter
 * (`logEvent`), the tenant-context wrapper (`runInTenantContext`),
 * and the soft-delete helpers. Exercises:
 *
 *   - RBAC gates on every entrypoint (assertCanRead / Write / Admin)
 *   - The `reviewEvidence` state machine (DRAFT/SUBMITTED/APPROVED/
 *     REJECTED/NEEDS_REVIEW transitions + author vs reviewer role)
 *   - `updateEvidence` three-state folder contract
 *     (undefined = no change, null = clear, string = set)
 *   - `getEvidence` / `updateEvidence` / `reviewEvidence` /
 *     `deleteEvidence` notFound propagation
 *   - Soft-delete / restore / purge delegation contracts
 *   - Cache-version bumps after writes (the only reliable contract
 *     between this usecase and the list view's React Query SWR).
 *
 * Out of scope (left for follow-up PRs):
 *   - `createEvidence` (file upload coupling — needs its own PR with
 *     a dedicated file storage mock harness)
 *   - `uploadEvidenceFile` (~200 LOC streaming/hash path)
 *   - `getEvidenceMetrics` (5-way Promise.all aggregate query)
 */

const mockDb = {
    user: { findUnique: jest.fn() },
    notification: { create: jest.fn() },
    evidence: { delete: jest.fn(), findMany: jest.fn() },
    practiceEvidenceLink: { create: jest.fn() },
    // SP audit — getEvidence now looks up an optional SharePoint sync mapping.
    integrationSyncMapping: { findFirst: jest.fn().mockResolvedValue(null) },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/repositories/EvidenceRepository', () => ({
    EvidenceRepository: {
        list: jest.fn(),
        listPaginated: jest.fn(),
        getById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        addReview: jest.fn(),
    },
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

jest.mock('@/lib/cache/list-cache', () => ({
    cachedListRead: jest.fn(async (opts: any) => opts.loader()),
    bumpEntityCacheVersion: jest.fn(),
}));

jest.mock('@/app-layer/usecases/soft-delete-operations', () => ({
    restoreEntity: jest.fn(),
    purgeEntity: jest.fn(),
}));

jest.mock('@/lib/soft-delete', () => ({
    withDeleted: jest.fn((args: any) => ({ ...args, _withDeleted: true })),
}));

import { EvidenceRepository } from '@/app-layer/repositories/EvidenceRepository';
import { logEvent } from '@/app-layer/events/audit';
import { cachedListRead, bumpEntityCacheVersion } from '@/lib/cache/list-cache';
import { restoreEntity, purgeEntity } from '@/app-layer/usecases/soft-delete-operations';
import {
    listEvidence,
    listEvidencePaginated,
    getEvidence,
    updateEvidence,
    reviewEvidence,
    deleteEvidence,
    restoreEvidence,
    purgeEvidence,
    listEvidenceWithDeleted,
} from '@/app-layer/usecases/evidence';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
});

const adminCtx = makeRequestContext('ADMIN', { userId: 'user-admin' });
const editorCtx = makeRequestContext('EDITOR', { userId: 'user-editor' });
const readerCtx = makeRequestContext('READER', { userId: 'user-reader' });
const auditorCtx = makeRequestContext('AUDITOR', { userId: 'user-auditor' });

// ─── listEvidence / listEvidencePaginated ──────────────────────────

describe('listEvidence', () => {
    it('returns rows from the repository under the cache layer', async () => {
        (EvidenceRepository.list as jest.Mock).mockResolvedValue([{ id: 'ev-1' }]);
        const rows = await listEvidence(readerCtx);
        expect(rows).toEqual([{ id: 'ev-1' }]);
        expect(cachedListRead).toHaveBeenCalledTimes(1);
        expect(EvidenceRepository.list).toHaveBeenCalledWith(mockDb, readerCtx, undefined, {});
    });

    it('forwards filters to the repository', async () => {
        (EvidenceRepository.list as jest.Mock).mockResolvedValue([]);
        await listEvidence(readerCtx, { type: 'FILE' as any });
        expect(EvidenceRepository.list).toHaveBeenCalledWith(
            mockDb,
            readerCtx,
            { type: 'FILE' },
            {},
        );
    });

    it('puts `take` into the cache key when supplied so bounded SSR results stay isolated', async () => {
        (EvidenceRepository.list as jest.Mock).mockResolvedValue([]);
        await listEvidence(readerCtx, undefined, { take: 50 });
        const cacheArgs = (cachedListRead as jest.Mock).mock.calls[0][0];
        expect(cacheArgs.params).toEqual({ _take: 50 });
        // Loader passes take through to the repo so the underlying query
        // honours the bound.
        expect(EvidenceRepository.list).toHaveBeenCalledWith(mockDb, readerCtx, undefined, { take: 50 });
    });
});

describe('listEvidencePaginated', () => {
    it('delegates to the paginated repository under the cache layer', async () => {
        (EvidenceRepository.listPaginated as jest.Mock).mockResolvedValue({ items: [], pageInfo: { hasNextPage: false, nextCursor: null } });
        const params = { limit: 25, cursor: undefined, filters: {} };
        const res = await listEvidencePaginated(readerCtx, params);
        expect(res.items).toEqual([]);
        expect(EvidenceRepository.listPaginated).toHaveBeenCalledWith(mockDb, readerCtx, params);
    });
});

// ─── getEvidence ────────────────────────────────────────────────────

describe('getEvidence', () => {
    it('returns the row on hit', async () => {
        (EvidenceRepository.getById as jest.Mock).mockResolvedValue({ id: 'ev-1', title: 'X' });
        const row = await getEvidence(readerCtx, 'ev-1');
        expect(row).toEqual({ id: 'ev-1', title: 'X' });
    });

    it('throws notFound when the repository returns null', async () => {
        (EvidenceRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(getEvidence(readerCtx, 'missing')).rejects.toThrow(/Evidence not found/i);
    });
});

// ─── updateEvidence — three-state folder contract ──────────────────

describe('updateEvidence', () => {
    it('forwards a string folder to the repository (set)', async () => {
        (EvidenceRepository.update as jest.Mock).mockResolvedValue({ id: 'ev-1' });
        await updateEvidence(editorCtx, 'ev-1', { folder: '  Finance/2026  ' } as any);
        const args = (EvidenceRepository.update as jest.Mock).mock.calls[0][3];
        expect(args.folder).toBe('Finance/2026'); // trimmed
    });

    it('forwards null folder to the repository (clear)', async () => {
        (EvidenceRepository.update as jest.Mock).mockResolvedValue({ id: 'ev-1' });
        await updateEvidence(editorCtx, 'ev-1', { folder: null } as any);
        const args = (EvidenceRepository.update as jest.Mock).mock.calls[0][3];
        expect(args.folder).toBeNull();
    });

    it('forwards undefined folder unchanged (no change to the column)', async () => {
        (EvidenceRepository.update as jest.Mock).mockResolvedValue({ id: 'ev-1' });
        await updateEvidence(editorCtx, 'ev-1', { title: 'changed' } as any);
        const args = (EvidenceRepository.update as jest.Mock).mock.calls[0][3];
        expect(args.folder).toBeUndefined();
    });

    it('coerces whitespace-only folder to null (clear)', async () => {
        (EvidenceRepository.update as jest.Mock).mockResolvedValue({ id: 'ev-1' });
        await updateEvidence(editorCtx, 'ev-1', { folder: '   ' } as any);
        const args = (EvidenceRepository.update as jest.Mock).mock.calls[0][3];
        expect(args.folder).toBeNull();
    });

    it('throws notFound when the repository returns null', async () => {
        (EvidenceRepository.update as jest.Mock).mockResolvedValue(null);
        await expect(updateEvidence(editorCtx, 'ev-1', { title: 'X' } as any)).rejects.toThrow(/Evidence not found/i);
    });

    it('bumps evidence cache version on success', async () => {
        (EvidenceRepository.update as jest.Mock).mockResolvedValue({ id: 'ev-1' });
        await updateEvidence(editorCtx, 'ev-1', { title: 'X' } as any);
        expect(bumpEntityCacheVersion).toHaveBeenCalledWith(editorCtx, 'evidence');
    });

    it('emits an UPDATE audit event', async () => {
        (EvidenceRepository.update as jest.Mock).mockResolvedValue({ id: 'ev-1' });
        await updateEvidence(editorCtx, 'ev-1', { title: 'X', category: 'C' } as any);
        expect(logEvent).toHaveBeenCalledTimes(1);
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('UPDATE');
        expect(payload.entityType).toBe('Evidence');
        expect(payload.entityId).toBe('ev-1');
    });

    it('rejects a READER (write gate)', async () => {
        await expect(updateEvidence(readerCtx, 'ev-1', { title: 'X' } as any)).rejects.toBeDefined();
        expect(EvidenceRepository.update).not.toHaveBeenCalled();
    });
});

// ─── reviewEvidence — state machine ────────────────────────────────

describe('reviewEvidence — author flow (SUBMITTED requires write/EDITOR)', () => {
    it('DRAFT → SUBMITTED is legal for an EDITOR', async () => {
        (EvidenceRepository.getById as jest.Mock).mockResolvedValue({ id: 'ev-1', status: 'DRAFT', title: 'X' });
        const res = await reviewEvidence(editorCtx, 'ev-1', { action: 'SUBMITTED' });
        expect(res).toEqual({ success: true, status: 'SUBMITTED' });
        expect(EvidenceRepository.update).toHaveBeenCalledWith(mockDb, editorCtx, 'ev-1', { status: 'SUBMITTED' });
        expect(EvidenceRepository.addReview).toHaveBeenCalledWith(mockDb, editorCtx, 'ev-1', 'SUBMITTED', undefined);
    });

    it('REJECTED → SUBMITTED is legal (resubmit after revisions)', async () => {
        (EvidenceRepository.getById as jest.Mock).mockResolvedValue({ id: 'ev-1', status: 'REJECTED', title: 'X' });
        const res = await reviewEvidence(editorCtx, 'ev-1', { action: 'SUBMITTED' });
        expect(res.status).toBe('SUBMITTED');
    });

    it('NEEDS_REVIEW → SUBMITTED is legal (re-submit stale)', async () => {
        (EvidenceRepository.getById as jest.Mock).mockResolvedValue({ id: 'ev-1', status: 'NEEDS_REVIEW', title: 'X' });
        const res = await reviewEvidence(editorCtx, 'ev-1', { action: 'SUBMITTED' });
        expect(res.status).toBe('SUBMITTED');
    });

    it('rejects READER attempting SUBMITTED (write gate)', async () => {
        await expect(reviewEvidence(readerCtx, 'ev-1', { action: 'SUBMITTED' })).rejects.toBeDefined();
        expect(EvidenceRepository.getById).not.toHaveBeenCalled();
    });
});

describe('reviewEvidence — reviewer flow (APPROVED/REJECTED requires admin)', () => {
    it('SUBMITTED → APPROVED is legal for an ADMIN', async () => {
        (EvidenceRepository.getById as jest.Mock).mockResolvedValue({ id: 'ev-1', status: 'SUBMITTED', title: 'X', ownerUserId: null });
        const res = await reviewEvidence(adminCtx, 'ev-1', { action: 'APPROVED' });
        expect(res.status).toBe('APPROVED');
    });

    it('SUBMITTED → REJECTED is legal for an ADMIN', async () => {
        (EvidenceRepository.getById as jest.Mock).mockResolvedValue({ id: 'ev-1', status: 'SUBMITTED', title: 'X', ownerUserId: null });
        const res = await reviewEvidence(adminCtx, 'ev-1', { action: 'REJECTED' });
        expect(res.status).toBe('REJECTED');
    });

    it('rejects EDITOR attempting APPROVED (admin gate)', async () => {
        await expect(reviewEvidence(editorCtx, 'ev-1', { action: 'APPROVED' })).rejects.toBeDefined();
        expect(EvidenceRepository.getById).not.toHaveBeenCalled();
    });

    it('sends an EVIDENCE_APPROVED notification to the owner when set', async () => {
        (EvidenceRepository.getById as jest.Mock).mockResolvedValue({ id: 'ev-1', status: 'SUBMITTED', title: 'X', ownerUserId: 'owner-1' });
        (mockDb.user.findUnique as jest.Mock).mockResolvedValue({ id: 'owner-1', email: 'o@e' });
        await reviewEvidence(adminCtx, 'ev-1', { action: 'APPROVED', comment: 'Great' });
        expect(mockDb.notification.create).toHaveBeenCalledTimes(1);
        const notif = (mockDb.notification.create as jest.Mock).mock.calls[0][0].data;
        expect(notif.type).toBe('EVIDENCE_APPROVED');
        expect(notif.userId).toBe('owner-1');
    });

    it('does NOT send a notification when ownerUserId is null (graceful degrade)', async () => {
        (EvidenceRepository.getById as jest.Mock).mockResolvedValue({ id: 'ev-1', status: 'SUBMITTED', title: 'X', ownerUserId: null });
        await reviewEvidence(adminCtx, 'ev-1', { action: 'APPROVED' });
        expect(mockDb.notification.create).not.toHaveBeenCalled();
    });

    it('does NOT send a notification for SUBMITTED state (author flow, no notify)', async () => {
        (EvidenceRepository.getById as jest.Mock).mockResolvedValue({ id: 'ev-1', status: 'DRAFT', title: 'X', ownerUserId: 'owner-1' });
        await reviewEvidence(editorCtx, 'ev-1', { action: 'SUBMITTED' });
        expect(mockDb.notification.create).not.toHaveBeenCalled();
    });
});

describe('reviewEvidence — illegal transitions', () => {
    it('rejects DRAFT → APPROVED (bypasses SUBMITTED)', async () => {
        (EvidenceRepository.getById as jest.Mock).mockResolvedValue({ id: 'ev-1', status: 'DRAFT', title: 'X' });
        await expect(reviewEvidence(adminCtx, 'ev-1', { action: 'APPROVED' })).rejects.toThrow(/Illegal evidence transition DRAFT . APPROVED/);
        expect(EvidenceRepository.update).not.toHaveBeenCalled();
    });

    it('rejects APPROVED → REJECTED (terminal state)', async () => {
        (EvidenceRepository.getById as jest.Mock).mockResolvedValue({ id: 'ev-1', status: 'APPROVED', title: 'X' });
        await expect(reviewEvidence(adminCtx, 'ev-1', { action: 'REJECTED' })).rejects.toThrow(/Illegal evidence transition/);
    });

    it('rejects unknown action with badRequest', async () => {
        await expect(reviewEvidence(adminCtx, 'ev-1', { action: 'BOGUS' })).rejects.toThrow(/Invalid review action/);
        expect(EvidenceRepository.getById).not.toHaveBeenCalled();
    });

    it('throws notFound when the evidence row is missing', async () => {
        (EvidenceRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(reviewEvidence(editorCtx, 'missing', { action: 'SUBMITTED' })).rejects.toThrow(/Evidence not found/i);
    });

    it('emits STATUS_CHANGE audit on every successful transition', async () => {
        (EvidenceRepository.getById as jest.Mock).mockResolvedValue({ id: 'ev-1', status: 'DRAFT', title: 'X' });
        await reviewEvidence(editorCtx, 'ev-1', { action: 'SUBMITTED' });
        expect(logEvent).toHaveBeenCalledTimes(1);
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('STATUS_CHANGE');
        expect(payload.detailsJson.fromStatus).toBe('DRAFT');
        expect(payload.detailsJson.toStatus).toBe('SUBMITTED');
    });

    it('bumps cache version on successful transition', async () => {
        (EvidenceRepository.getById as jest.Mock).mockResolvedValue({ id: 'ev-1', status: 'DRAFT', title: 'X' });
        await reviewEvidence(editorCtx, 'ev-1', { action: 'SUBMITTED' });
        expect(bumpEntityCacheVersion).toHaveBeenCalledWith(editorCtx, 'evidence');
    });
});

// ─── deleteEvidence / restoreEvidence / purgeEvidence ──────────────

describe('deleteEvidence', () => {
    it('soft-deletes and emits an audit event for ADMIN', async () => {
        (EvidenceRepository.getById as jest.Mock).mockResolvedValue({ id: 'ev-1', title: 'X' });
        (mockDb.evidence.delete as jest.Mock).mockResolvedValue({});
        const res = await deleteEvidence(adminCtx, 'ev-1');
        expect(res).toEqual({ success: true });
        expect(mockDb.evidence.delete).toHaveBeenCalledWith({ where: { id: 'ev-1' } });
        const auditPayload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(auditPayload.action).toBe('SOFT_DELETE');
        expect(bumpEntityCacheVersion).toHaveBeenCalledWith(adminCtx, 'evidence');
    });

    it('throws notFound when the row is missing', async () => {
        (EvidenceRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(deleteEvidence(adminCtx, 'missing')).rejects.toThrow(/Evidence not found/i);
        expect(mockDb.evidence.delete).not.toHaveBeenCalled();
    });

    it('rejects EDITOR (admin gate)', async () => {
        await expect(deleteEvidence(editorCtx, 'ev-1')).rejects.toBeDefined();
        expect(EvidenceRepository.getById).not.toHaveBeenCalled();
    });

    it('rejects READER (admin gate)', async () => {
        await expect(deleteEvidence(readerCtx, 'ev-1')).rejects.toBeDefined();
    });
});

describe('restoreEvidence', () => {
    it('delegates to restoreEntity with the Evidence entity name', async () => {
        (restoreEntity as jest.Mock).mockResolvedValue({ success: true });
        const res = await restoreEvidence(adminCtx, 'ev-1');
        expect(res).toEqual({ success: true });
        expect(restoreEntity).toHaveBeenCalledWith(adminCtx, 'Evidence', 'ev-1');
        expect(bumpEntityCacheVersion).toHaveBeenCalledWith(adminCtx, 'evidence');
    });
});

describe('purgeEvidence', () => {
    it('delegates to purgeEntity with the Evidence entity name', async () => {
        (purgeEntity as jest.Mock).mockResolvedValue({ success: true });
        const res = await purgeEvidence(adminCtx, 'ev-1');
        expect(res).toEqual({ success: true });
        expect(purgeEntity).toHaveBeenCalledWith(adminCtx, 'Evidence', 'ev-1');
        expect(bumpEntityCacheVersion).toHaveBeenCalledWith(adminCtx, 'evidence');
    });
});

// ─── listEvidenceWithDeleted (admin only) ──────────────────────────

describe('listEvidenceWithDeleted', () => {
    it('returns evidence rows including soft-deleted under ADMIN', async () => {
        (mockDb.evidence.findMany as jest.Mock).mockResolvedValue([{ id: 'ev-1' }, { id: 'ev-2', deletedAt: new Date() }]);
        const rows = await listEvidenceWithDeleted(adminCtx);
        expect(rows).toHaveLength(2);
        // The withDeleted helper is invoked (annotated for the test mock)
        const findManyArgs = (mockDb.evidence.findMany as jest.Mock).mock.calls[0][0];
        expect(findManyArgs._withDeleted).toBe(true);
    });

    it('rejects AUDITOR (admin gate, not audit gate)', async () => {
        await expect(listEvidenceWithDeleted(auditorCtx)).rejects.toBeDefined();
        expect(mockDb.evidence.findMany).not.toHaveBeenCalled();
    });

    it('rejects READER (admin gate)', async () => {
        await expect(listEvidenceWithDeleted(readerCtx)).rejects.toBeDefined();
    });
});

// ─── RBAC denials on read entrypoints ───────────────────────────────

describe('RBAC — denials on read entrypoints', () => {
    // AUDITOR has canRead=true → reads OK. There's no role with
    // canRead=false today (the gate is just `assertCanRead`), so this
    // assertion is principally a smoke check on the gate's presence.
    it('AUDITOR can listEvidence', async () => {
        (EvidenceRepository.list as jest.Mock).mockResolvedValue([]);
        await expect(listEvidence(auditorCtx)).resolves.toEqual([]);
    });

    it('AUDITOR can getEvidence', async () => {
        (EvidenceRepository.getById as jest.Mock).mockResolvedValue({ id: 'ev-1' });
        await expect(getEvidence(auditorCtx, 'ev-1')).resolves.toEqual({ id: 'ev-1' });
    });
});
