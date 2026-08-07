/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio
 * (see tests/unit/control-applicability.test.ts). */

/**
 * Unit tests for `src/app-layer/usecases/control/mutations.ts`.
 *
 * Roadmap Q1 — Compliance core. setControlApplicability already has
 * a dedicated test file (tests/unit/control-applicability.test.ts);
 * this file covers the rest of mutations.ts:
 *
 *   - createControl — CTL-N sequence upsert, plan-limit gate
 *     (assertWithinLimit), framework-installed branch bypass.
 *   - updateControl — patch shape, global-control protection
 *     (no tenantId means the read still finds it but the update
 *     returns null → 403 forbidden).
 *   - setControlStatus — existence check, global protection, audit
 *     fromStatus/toStatus shape.
 *   - setControlOwner — user existence check ($queryRawUnsafe),
 *     notification creation post-commit, audit shape.
 *   - markControlTestCompleted — NOT_APPLICABLE block, cadence
 *     computation via computeNextDueAt.
 *   - deleteControl / restoreControl / purgeControl — global
 *     protection on delete, soft-delete delegation, admin gate.
 */

const mockDb = {
    controlKeySequence: { upsert: jest.fn() },
    control: { delete: jest.fn() },
    $queryRawUnsafe: jest.fn(),
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/repositories/ControlRepository', () => ({
    ControlRepository: {
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

import { ControlRepository } from '@/app-layer/repositories/ControlRepository';
import { logEvent } from '@/app-layer/events/audit';
import { bumpEntityCacheVersion } from '@/lib/cache/list-cache';
import { assertWithinLimit } from '@/lib/billing/entitlements';
import { createAssignmentNotification } from '@/app-layer/notifications/assignment';
import { restoreEntity, purgeEntity } from '@/app-layer/usecases/soft-delete-operations';
import { computeNextDueAt } from '@/app-layer/utils/cadence';
import {
    createControl,
    updateControl,
    setControlStatus,
    setControlOwner,
    markControlTestCompleted,
    deleteControl,
    restoreControl,
    purgeControl,
} from '@/app-layer/usecases/control/mutations';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
});

const adminCtx = makeRequestContext('ADMIN', { tenantSlug: 'acme' });
const editorCtx = makeRequestContext('EDITOR', { tenantSlug: 'acme' });
const readerCtx = makeRequestContext('READER', { tenantSlug: 'acme' });

// ─── createControl ─────────────────────────────────────────────────

describe('createControl', () => {
    it('mints a CTL-N code via the per-tenant sequence when none supplied', async () => {
        (assertWithinLimit as jest.Mock).mockResolvedValue(undefined);
        (mockDb.controlKeySequence.upsert as jest.Mock).mockResolvedValue({ lastValue: 7 });
        (ControlRepository.create as jest.Mock).mockResolvedValue({ id: 'c-1', code: 'CTL-7' });

        const res = await createControl(adminCtx, { name: 'My control' });

        expect(res).toEqual({ id: 'c-1', code: 'CTL-7' });
        expect(mockDb.controlKeySequence.upsert).toHaveBeenCalledWith({
            where: { tenantId: adminCtx.tenantId },
            create: { tenantId: adminCtx.tenantId, lastValue: 1 },
            update: { lastValue: { increment: 1 } },
        });
        const createArgs = (ControlRepository.create as jest.Mock).mock.calls[0][2];
        expect(createArgs.code).toBe('CTL-7');
    });

    it('skips the sequence when an explicit code is supplied (framework install path)', async () => {
        (assertWithinLimit as jest.Mock).mockResolvedValue(undefined);
        (ControlRepository.create as jest.Mock).mockResolvedValue({ id: 'c-1', code: 'A.5.1' });

        await createControl(adminCtx, { name: 'Framework control', code: 'A.5.1' });

        expect(mockDb.controlKeySequence.upsert).not.toHaveBeenCalled();
        const createArgs = (ControlRepository.create as jest.Mock).mock.calls[0][2];
        expect(createArgs.code).toBe('A.5.1');
    });

    it('skips the sequence when isCustom=false (catalogue-installed control)', async () => {
        (assertWithinLimit as jest.Mock).mockResolvedValue(undefined);
        (ControlRepository.create as jest.Mock).mockResolvedValue({ id: 'c-1' });

        await createControl(adminCtx, { name: 'A control', isCustom: false });

        expect(mockDb.controlKeySequence.upsert).not.toHaveBeenCalled();
    });

    it('emits CONTROL_CREATED audit', async () => {
        (assertWithinLimit as jest.Mock).mockResolvedValue(undefined);
        (mockDb.controlKeySequence.upsert as jest.Mock).mockResolvedValue({ lastValue: 1 });
        (ControlRepository.create as jest.Mock).mockResolvedValue({ id: 'c-1', code: 'CTL-1', name: 'X' });

        await createControl(adminCtx, { name: 'X' });

        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('CONTROL_CREATED');
        expect(payload.entityType).toBe('Control');
    });

    it('bumps cache version after commit', async () => {
        (assertWithinLimit as jest.Mock).mockResolvedValue(undefined);
        (mockDb.controlKeySequence.upsert as jest.Mock).mockResolvedValue({ lastValue: 1 });
        (ControlRepository.create as jest.Mock).mockResolvedValue({ id: 'c-1' });

        await createControl(adminCtx, { name: 'X' });

        expect(bumpEntityCacheVersion).toHaveBeenCalledWith(adminCtx, 'control');
    });

    it('propagates plan-limit error from assertWithinLimit (does not reach DB)', async () => {
        (assertWithinLimit as jest.Mock).mockRejectedValue(new Error('plan_limit_exceeded: control(10)'));

        await expect(createControl(adminCtx, { name: 'X' })).rejects.toThrow(/plan_limit_exceeded/);
        expect(mockDb.controlKeySequence.upsert).not.toHaveBeenCalled();
        expect(ControlRepository.create).not.toHaveBeenCalled();
    });

    it('rejects READER (create gate)', async () => {
        await expect(createControl(readerCtx, { name: 'X' })).rejects.toBeDefined();
        expect(assertWithinLimit).not.toHaveBeenCalled();
    });
});

// ─── updateControl ─────────────────────────────────────────────────

describe('updateControl', () => {
    it('happy path — updates and emits audit', async () => {
        (ControlRepository.update as jest.Mock).mockResolvedValue({ id: 'c-1', name: 'New' });

        const res = await updateControl(editorCtx, 'c-1', { name: 'New' });

        expect(res).toEqual({ id: 'c-1', name: 'New' });
        expect(logEvent).toHaveBeenCalledTimes(1);
        expect(bumpEntityCacheVersion).toHaveBeenCalledWith(editorCtx, 'control');
    });

    it('omits undefined fields from the update payload (patch shape)', async () => {
        (ControlRepository.update as jest.Mock).mockResolvedValue({ id: 'c-1' });

        await updateControl(editorCtx, 'c-1', { name: 'Just the name' });

        const updateData = (ControlRepository.update as jest.Mock).mock.calls[0][3];
        expect(updateData).toEqual({ name: 'Just the name' });
        expect(updateData).not.toHaveProperty('description');
    });

    it('throws forbidden when the row exists but the update returns null (global library)', async () => {
        (ControlRepository.update as jest.Mock).mockResolvedValue(null);
        (ControlRepository.getById as jest.Mock).mockResolvedValue({ id: 'c-1' }); // global

        await expect(updateControl(editorCtx, 'c-1', { name: 'X' })).rejects.toThrow(/global library controls/i);
    });

    it('throws notFound when neither update nor getById finds the row', async () => {
        (ControlRepository.update as jest.Mock).mockResolvedValue(null);
        (ControlRepository.getById as jest.Mock).mockResolvedValue(null);

        await expect(updateControl(editorCtx, 'missing', { name: 'X' })).rejects.toThrow(/Control not found/i);
    });

    it('rejects READER (update gate)', async () => {
        await expect(updateControl(readerCtx, 'c-1', { name: 'X' })).rejects.toBeDefined();
    });
});

// ─── setControlStatus ──────────────────────────────────────────────

describe('setControlStatus', () => {
    it('updates status and emits CONTROL_STATUS_CHANGED', async () => {
        (ControlRepository.getById as jest.Mock).mockResolvedValue({
            id: 'c-1', status: 'NOT_STARTED', tenantId: editorCtx.tenantId,
        });
        (ControlRepository.update as jest.Mock).mockResolvedValue({ id: 'c-1', status: 'IMPLEMENTED' });

        const res = await setControlStatus(editorCtx, 'c-1', 'IMPLEMENTED');

        expect(res.status).toBe('IMPLEMENTED');
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('CONTROL_STATUS_CHANGED');
        expect(payload.detailsJson.fromStatus).toBe('NOT_STARTED');
        expect(payload.detailsJson.toStatus).toBe('IMPLEMENTED');
    });

    it('throws notFound when the control does not exist', async () => {
        (ControlRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(setControlStatus(editorCtx, 'missing', 'IMPLEMENTED')).rejects.toThrow(/Control not found/i);
    });

    it('throws forbidden when the control is a global library row (tenantId null)', async () => {
        (ControlRepository.getById as jest.Mock).mockResolvedValue({ id: 'c-1', tenantId: null });
        await expect(setControlStatus(editorCtx, 'c-1', 'IMPLEMENTED')).rejects.toThrow(/global library/i);
        expect(ControlRepository.update).not.toHaveBeenCalled();
    });

    it('rejects READER', async () => {
        await expect(setControlStatus(readerCtx, 'c-1', 'IMPLEMENTED')).rejects.toBeDefined();
    });
});

// ─── setControlOwner ───────────────────────────────────────────────

describe('setControlOwner', () => {
    it('validates the user via $queryRawUnsafe before updating', async () => {
        (mockDb.$queryRawUnsafe as jest.Mock).mockResolvedValue([{ id: 'u-1' }]);
        (ControlRepository.setOwner as jest.Mock).mockResolvedValue({ id: 'c-1', name: 'X', code: 'A.5' });
        (createAssignmentNotification as jest.Mock).mockResolvedValue(undefined);

        await setControlOwner(editorCtx, 'c-1', 'u-1');

        expect(mockDb.$queryRawUnsafe).toHaveBeenCalledTimes(1);
        const queryArgs = (mockDb.$queryRawUnsafe as jest.Mock).mock.calls[0];
        expect(queryArgs[0]).toMatch(/FROM "User" WHERE id/);
        expect(queryArgs[1]).toBe('u-1');
    });

    it('throws badRequest when the user does not exist', async () => {
        (mockDb.$queryRawUnsafe as jest.Mock).mockResolvedValue([]);
        await expect(setControlOwner(editorCtx, 'c-1', 'ghost')).rejects.toThrow(/not found/i);
        expect(ControlRepository.setOwner).not.toHaveBeenCalled();
    });

    it('skips user lookup when clearing ownership (null)', async () => {
        (ControlRepository.setOwner as jest.Mock).mockResolvedValue({ id: 'c-1', name: 'X', code: 'A.5' });

        await setControlOwner(editorCtx, 'c-1', null);

        expect(mockDb.$queryRawUnsafe).not.toHaveBeenCalled();
        expect(createAssignmentNotification).not.toHaveBeenCalled();
    });

    it('creates an in-app assignment notification for the new owner', async () => {
        (mockDb.$queryRawUnsafe as jest.Mock).mockResolvedValue([{ id: 'u-1' }]);
        (ControlRepository.setOwner as jest.Mock).mockResolvedValue({ id: 'c-1', name: 'X', code: 'A.5' });
        (createAssignmentNotification as jest.Mock).mockResolvedValue(undefined);

        await setControlOwner(editorCtx, 'c-1', 'u-1');

        expect(createAssignmentNotification).toHaveBeenCalledTimes(1);
        const args = (createAssignmentNotification as jest.Mock).mock.calls[0];
        expect(args[1]).toBe('CONTROL_ASSIGNED');
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
        (ControlRepository.setOwner as jest.Mock).mockResolvedValue({ id: 'c-1', name: 'X', code: 'A.5' });
        (createAssignmentNotification as jest.Mock).mockRejectedValue(new Error('Redis down'));

        // Should resolve, not throw
        await expect(setControlOwner(editorCtx, 'c-1', 'u-1')).resolves.toMatchObject({ id: 'c-1' });
    });

    it('throws notFound when the control does not exist', async () => {
        (ControlRepository.setOwner as jest.Mock).mockResolvedValue(null);
        await expect(setControlOwner(editorCtx, 'missing', null)).rejects.toThrow(/Control not found/i);
    });

    it('rejects READER', async () => {
        await expect(setControlOwner(readerCtx, 'c-1', 'u-1')).rejects.toBeDefined();
    });
});

// ─── markControlTestCompleted ──────────────────────────────────────


// ─── deleteControl / restoreControl / purgeControl ─────────────────

describe('deleteControl', () => {
    it('soft-deletes and emits audit for ADMIN', async () => {
        (ControlRepository.getById as jest.Mock).mockResolvedValue({
            id: 'c-1', code: 'A.5', name: 'X', tenantId: adminCtx.tenantId,
        });
        (mockDb.control.delete as jest.Mock).mockResolvedValue({});

        const res = await deleteControl(adminCtx, 'c-1');

        expect(res).toEqual({ success: true });
        expect(mockDb.control.delete).toHaveBeenCalledWith({ where: { id: 'c-1' } });
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('SOFT_DELETE');
    });

    it('throws notFound when the control does not exist', async () => {
        (ControlRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(deleteControl(adminCtx, 'missing')).rejects.toThrow(/Control not found/i);
        expect(mockDb.control.delete).not.toHaveBeenCalled();
    });

    it('throws forbidden for global library controls', async () => {
        (ControlRepository.getById as jest.Mock).mockResolvedValue({ id: 'c-1', tenantId: null });
        await expect(deleteControl(adminCtx, 'c-1')).rejects.toThrow(/global library/i);
    });

    it('rejects EDITOR (admin gate)', async () => {
        await expect(deleteControl(editorCtx, 'c-1')).rejects.toBeDefined();
        expect(ControlRepository.getById).not.toHaveBeenCalled();
    });
});

describe('restoreControl', () => {
    it('delegates to restoreEntity', async () => {
        (restoreEntity as jest.Mock).mockResolvedValue({ success: true });
        const res = await restoreControl(adminCtx, 'c-1');
        expect(res).toEqual({ success: true });
        expect(restoreEntity).toHaveBeenCalledWith(adminCtx, 'Control', 'c-1');
        expect(bumpEntityCacheVersion).toHaveBeenCalledWith(adminCtx, 'control');
    });
});

describe('purgeControl', () => {
    it('delegates to purgeEntity', async () => {
        (purgeEntity as jest.Mock).mockResolvedValue({ success: true });
        const res = await purgeControl(adminCtx, 'c-1');
        expect(res).toEqual({ success: true });
        expect(purgeEntity).toHaveBeenCalledWith(adminCtx, 'Control', 'c-1');
        expect(bumpEntityCacheVersion).toHaveBeenCalledWith(adminCtx, 'control');
    });
});
