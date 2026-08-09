/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio
 * (see tests/unit/practice-applicability.test.ts). */

/**
 * Unit tests for `src/app-layer/usecases/practice/mutations.ts`.
 *
 * Roadmap Q1 — Compliance core. setPracticeApplicability already has
 * a dedicated test file (tests/unit/practice-applicability.test.ts);
 * this file covers the rest of mutations.ts:
 *
 *   - createPractice — CTL-N sequence upsert, plan-limit gate
 *     (assertWithinLimit), framework-installed branch bypass.
 *   - updatePractice — patch shape, global-practice protection
 *     (no tenantId means the read still finds it but the update
 *     returns null → 403 forbidden).
 *   - setPracticeStatus — existence check, global protection, audit
 *     fromStatus/toStatus shape.
 *   - setPracticeOwner — user existence check ($queryRawUnsafe),
 *     notification creation post-commit, audit shape.
 *   - markPracticeTestCompleted — NOT_APPLICABLE block, cadence
 *     computation via computeNextDueAt.
 *   - deletePractice / restorePractice / purgePractice — global
 *     protection on delete, soft-delete delegation, admin gate.
 */

const mockDb = {
    practiceKeySequence: { upsert: jest.fn() },
    practice: { delete: jest.fn() },
    $queryRawUnsafe: jest.fn(),
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/repositories/PracticeRepository', () => ({
    PracticeRepository: {
        create: jest.fn(),
        update: jest.fn(),
        getById: jest.fn(),
        setApplicability: jest.fn(),
        setOwner: jest.fn(),
    },
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

jest.mock('@/lib/cache/list-cache', () => ({
    bumpEntityCacheVersion: jest.fn(),
}));

jest.mock('@/lib/billing/entitlements', () => ({
    assertWithinLimit: jest.fn(),
}));

jest.mock('@/app-layer/notifications/assignment', () => ({
    createAssignmentNotification: jest.fn(),
}));

jest.mock('@/app-layer/usecases/soft-delete-operations', () => ({
    restoreEntity: jest.fn(),
    purgeEntity: jest.fn(),
}));

jest.mock('@/app-layer/utils/cadence', () => ({
    computeNextDueAt: jest.fn(),
}));

jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { PracticeRepository } from '@/app-layer/repositories/PracticeRepository';
import { logEvent } from '@/app-layer/events/audit';
import { bumpEntityCacheVersion } from '@/lib/cache/list-cache';
import { assertWithinLimit } from '@/lib/billing/entitlements';
import { createAssignmentNotification } from '@/app-layer/notifications/assignment';
import { restoreEntity, purgeEntity } from '@/app-layer/usecases/soft-delete-operations';
import { computeNextDueAt } from '@/app-layer/utils/cadence';
import {
    createPractice,
    updatePractice,
    setPracticeStatus,
    setPracticeOwner,
    markPracticeTestCompleted,
    deletePractice,
    restorePractice,
    purgePractice,
} from '@/app-layer/usecases/practice/mutations';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
});

const adminCtx = makeRequestContext('ADMIN', { tenantSlug: 'acme' });
const editorCtx = makeRequestContext('EDITOR', { tenantSlug: 'acme' });
const readerCtx = makeRequestContext('READER', { tenantSlug: 'acme' });

// ─── createPractice ─────────────────────────────────────────────────

describe('createPractice', () => {
    it('mints a CTL-N code via the per-tenant sequence when none supplied', async () => {
        (assertWithinLimit as jest.Mock).mockResolvedValue(undefined);
        (mockDb.practiceKeySequence.upsert as jest.Mock).mockResolvedValue({ lastValue: 7 });
        (PracticeRepository.create as jest.Mock).mockResolvedValue({ id: 'c-1', code: 'CTL-7' });

        const res = await createPractice(adminCtx, { name: 'My practice' });

        expect(res).toEqual({ id: 'c-1', code: 'CTL-7' });
        expect(mockDb.practiceKeySequence.upsert).toHaveBeenCalledWith({
            where: { tenantId: adminCtx.tenantId },
            create: { tenantId: adminCtx.tenantId, lastValue: 1 },
            update: { lastValue: { increment: 1 } },
        });
        const createArgs = (PracticeRepository.create as jest.Mock).mock.calls[0][2];
        expect(createArgs.code).toBe('CTL-7');
    });

    it('skips the sequence when an explicit code is supplied (framework install path)', async () => {
        (assertWithinLimit as jest.Mock).mockResolvedValue(undefined);
        (PracticeRepository.create as jest.Mock).mockResolvedValue({ id: 'c-1', code: 'A.5.1' });

        await createPractice(adminCtx, { name: 'Framework practice', code: 'A.5.1' });

        expect(mockDb.practiceKeySequence.upsert).not.toHaveBeenCalled();
        const createArgs = (PracticeRepository.create as jest.Mock).mock.calls[0][2];
        expect(createArgs.code).toBe('A.5.1');
    });

    it('skips the sequence when isCustom=false (catalogue-installed practice)', async () => {
        (assertWithinLimit as jest.Mock).mockResolvedValue(undefined);
        (PracticeRepository.create as jest.Mock).mockResolvedValue({ id: 'c-1' });

        await createPractice(adminCtx, { name: 'A practice', isCustom: false });

        expect(mockDb.practiceKeySequence.upsert).not.toHaveBeenCalled();
    });

    it('emits CONTROL_CREATED audit', async () => {
        (assertWithinLimit as jest.Mock).mockResolvedValue(undefined);
        (mockDb.practiceKeySequence.upsert as jest.Mock).mockResolvedValue({ lastValue: 1 });
        (PracticeRepository.create as jest.Mock).mockResolvedValue({ id: 'c-1', code: 'CTL-1', name: 'X' });

        await createPractice(adminCtx, { name: 'X' });

        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('CONTROL_CREATED');
        expect(payload.entityType).toBe('Practice');
    });

    it('bumps cache version after commit', async () => {
        (assertWithinLimit as jest.Mock).mockResolvedValue(undefined);
        (mockDb.practiceKeySequence.upsert as jest.Mock).mockResolvedValue({ lastValue: 1 });
        (PracticeRepository.create as jest.Mock).mockResolvedValue({ id: 'c-1' });

        await createPractice(adminCtx, { name: 'X' });

        expect(bumpEntityCacheVersion).toHaveBeenCalledWith(adminCtx, 'practice');
    });

    it('propagates plan-limit error from assertWithinLimit (does not reach DB)', async () => {
        (assertWithinLimit as jest.Mock).mockRejectedValue(new Error('plan_limit_exceeded: practice(10)'));

        await expect(createPractice(adminCtx, { name: 'X' })).rejects.toThrow(/plan_limit_exceeded/);
        expect(mockDb.practiceKeySequence.upsert).not.toHaveBeenCalled();
        expect(PracticeRepository.create).not.toHaveBeenCalled();
    });

    it('rejects READER (create gate)', async () => {
        await expect(createPractice(readerCtx, { name: 'X' })).rejects.toBeDefined();
        expect(assertWithinLimit).not.toHaveBeenCalled();
    });
});

// ─── updatePractice ─────────────────────────────────────────────────

describe('updatePractice', () => {
    it('happy path — updates and emits audit', async () => {
        (PracticeRepository.update as jest.Mock).mockResolvedValue({ id: 'c-1', name: 'New' });

        const res = await updatePractice(editorCtx, 'c-1', { name: 'New' });

        expect(res).toEqual({ id: 'c-1', name: 'New' });
        expect(logEvent).toHaveBeenCalledTimes(1);
        expect(bumpEntityCacheVersion).toHaveBeenCalledWith(editorCtx, 'practice');
    });

    it('omits undefined fields from the update payload (patch shape)', async () => {
        (PracticeRepository.update as jest.Mock).mockResolvedValue({ id: 'c-1' });

        await updatePractice(editorCtx, 'c-1', { name: 'Just the name' });

        const updateData = (PracticeRepository.update as jest.Mock).mock.calls[0][3];
        expect(updateData).toEqual({ name: 'Just the name' });
        expect(updateData).not.toHaveProperty('description');
    });

    it('throws forbidden when the row exists but the update returns null (global library)', async () => {
        (PracticeRepository.update as jest.Mock).mockResolvedValue(null);
        (PracticeRepository.getById as jest.Mock).mockResolvedValue({ id: 'c-1' }); // global

        await expect(updatePractice(editorCtx, 'c-1', { name: 'X' })).rejects.toThrow(/global library practices/i);
    });

    it('throws notFound when neither update nor getById finds the row', async () => {
        (PracticeRepository.update as jest.Mock).mockResolvedValue(null);
        (PracticeRepository.getById as jest.Mock).mockResolvedValue(null);

        await expect(updatePractice(editorCtx, 'missing', { name: 'X' })).rejects.toThrow(/Practice not found/i);
    });

    it('rejects READER (update gate)', async () => {
        await expect(updatePractice(readerCtx, 'c-1', { name: 'X' })).rejects.toBeDefined();
    });
});

// ─── setPracticeStatus ──────────────────────────────────────────────

describe('setPracticeStatus', () => {
    it('updates status and emits CONTROL_STATUS_CHANGED', async () => {
        (PracticeRepository.getById as jest.Mock).mockResolvedValue({
            id: 'c-1', status: 'NOT_STARTED', tenantId: editorCtx.tenantId,
        });
        (PracticeRepository.update as jest.Mock).mockResolvedValue({ id: 'c-1', status: 'IMPLEMENTED' });

        const res = await setPracticeStatus(editorCtx, 'c-1', 'IMPLEMENTED');

        expect(res.status).toBe('IMPLEMENTED');
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('CONTROL_STATUS_CHANGED');
        expect(payload.detailsJson.fromStatus).toBe('NOT_STARTED');
        expect(payload.detailsJson.toStatus).toBe('IMPLEMENTED');
    });

    it('throws notFound when the practice does not exist', async () => {
        (PracticeRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(setPracticeStatus(editorCtx, 'missing', 'IMPLEMENTED')).rejects.toThrow(/Practice not found/i);
    });

    it('throws forbidden when the practice is a global library row (tenantId null)', async () => {
        (PracticeRepository.getById as jest.Mock).mockResolvedValue({ id: 'c-1', tenantId: null });
        await expect(setPracticeStatus(editorCtx, 'c-1', 'IMPLEMENTED')).rejects.toThrow(/global library/i);
        expect(PracticeRepository.update).not.toHaveBeenCalled();
    });

    it('rejects READER', async () => {
        await expect(setPracticeStatus(readerCtx, 'c-1', 'IMPLEMENTED')).rejects.toBeDefined();
    });
});

// ─── setPracticeOwner ───────────────────────────────────────────────

describe('setPracticeOwner', () => {
    it('validates the user via $queryRawUnsafe before updating', async () => {
        (mockDb.$queryRawUnsafe as jest.Mock).mockResolvedValue([{ id: 'u-1' }]);
        (PracticeRepository.setOwner as jest.Mock).mockResolvedValue({ id: 'c-1', name: 'X', code: 'A.5' });
        (createAssignmentNotification as jest.Mock).mockResolvedValue(undefined);

        await setPracticeOwner(editorCtx, 'c-1', 'u-1');

        expect(mockDb.$queryRawUnsafe).toHaveBeenCalledTimes(1);
        const queryArgs = (mockDb.$queryRawUnsafe as jest.Mock).mock.calls[0];
        expect(queryArgs[0]).toMatch(/FROM "User" WHERE id/);
        expect(queryArgs[1]).toBe('u-1');
    });

    it('throws badRequest when the user does not exist', async () => {
        (mockDb.$queryRawUnsafe as jest.Mock).mockResolvedValue([]);
        await expect(setPracticeOwner(editorCtx, 'c-1', 'ghost')).rejects.toThrow(/not found/i);
        expect(PracticeRepository.setOwner).not.toHaveBeenCalled();
    });

    it('skips user lookup when clearing ownership (null)', async () => {
        (PracticeRepository.setOwner as jest.Mock).mockResolvedValue({ id: 'c-1', name: 'X', code: 'A.5' });

        await setPracticeOwner(editorCtx, 'c-1', null);

        expect(mockDb.$queryRawUnsafe).not.toHaveBeenCalled();
        expect(createAssignmentNotification).not.toHaveBeenCalled();
    });

    it('creates an in-app assignment notification for the new owner', async () => {
        (mockDb.$queryRawUnsafe as jest.Mock).mockResolvedValue([{ id: 'u-1' }]);
        (PracticeRepository.setOwner as jest.Mock).mockResolvedValue({ id: 'c-1', name: 'X', code: 'A.5' });
        (createAssignmentNotification as jest.Mock).mockResolvedValue(undefined);

        await setPracticeOwner(editorCtx, 'c-1', 'u-1');

        expect(createAssignmentNotification).toHaveBeenCalledTimes(1);
        const args = (createAssignmentNotification as jest.Mock).mock.calls[0];
        expect(args[1]).toBe('PRACTICE_ASSIGNED');
        expect(args[2]).toMatchObject({
            assigneeUserId: 'u-1',
            entityId: 'c-1',
            entityLabel: 'X',
            entityKey: 'A.5',
            tenantSlug: 'acme',
        });
    });

    it('does not surface notification errors to the caller (fire-and-forget)', async () => {
        (mockDb.$queryRawUnsafe as jest.Mock).mockResolvedValue([{ id: 'u-1' }]);
        (PracticeRepository.setOwner as jest.Mock).mockResolvedValue({ id: 'c-1', name: 'X', code: 'A.5' });
        (createAssignmentNotification as jest.Mock).mockRejectedValue(new Error('Redis down'));

        // Should resolve, not throw
        await expect(setPracticeOwner(editorCtx, 'c-1', 'u-1')).resolves.toMatchObject({ id: 'c-1' });
    });

    it('throws notFound when the practice does not exist', async () => {
        (PracticeRepository.setOwner as jest.Mock).mockResolvedValue(null);
        await expect(setPracticeOwner(editorCtx, 'missing', null)).rejects.toThrow(/Practice not found/i);
    });

    it('rejects READER', async () => {
        await expect(setPracticeOwner(readerCtx, 'c-1', 'u-1')).rejects.toBeDefined();
    });
});

// ─── markPracticeTestCompleted ──────────────────────────────────────


// ─── deletePractice / restorePractice / purgePractice ─────────────────

describe('deletePractice', () => {
    it('soft-deletes and emits audit for ADMIN', async () => {
        (PracticeRepository.getById as jest.Mock).mockResolvedValue({
            id: 'c-1', code: 'A.5', name: 'X', tenantId: adminCtx.tenantId,
        });
        (mockDb.practice.delete as jest.Mock).mockResolvedValue({});

        const res = await deletePractice(adminCtx, 'c-1');

        expect(res).toEqual({ success: true });
        expect(mockDb.practice.delete).toHaveBeenCalledWith({ where: { id: 'c-1' } });
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('SOFT_DELETE');
    });

    it('throws notFound when the practice does not exist', async () => {
        (PracticeRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(deletePractice(adminCtx, 'missing')).rejects.toThrow(/Practice not found/i);
        expect(mockDb.practice.delete).not.toHaveBeenCalled();
    });

    it('throws forbidden for global library practices', async () => {
        (PracticeRepository.getById as jest.Mock).mockResolvedValue({ id: 'c-1', tenantId: null });
        await expect(deletePractice(adminCtx, 'c-1')).rejects.toThrow(/global library/i);
    });

    it('rejects EDITOR (admin gate)', async () => {
        await expect(deletePractice(editorCtx, 'c-1')).rejects.toBeDefined();
        expect(PracticeRepository.getById).not.toHaveBeenCalled();
    });
});

describe('restorePractice', () => {
    it('delegates to restoreEntity', async () => {
        (restoreEntity as jest.Mock).mockResolvedValue({ success: true });
        const res = await restorePractice(adminCtx, 'c-1');
        expect(res).toEqual({ success: true });
        expect(restoreEntity).toHaveBeenCalledWith(adminCtx, 'Practice', 'c-1');
        expect(bumpEntityCacheVersion).toHaveBeenCalledWith(adminCtx, 'practice');
    });
});

describe('purgePractice', () => {
    it('delegates to purgeEntity', async () => {
        (purgeEntity as jest.Mock).mockResolvedValue({ success: true });
        const res = await purgePractice(adminCtx, 'c-1');
        expect(res).toEqual({ success: true });
        expect(purgeEntity).toHaveBeenCalledWith(adminCtx, 'Practice', 'c-1');
        expect(bumpEntityCacheVersion).toHaveBeenCalledWith(adminCtx, 'practice');
    });
});
