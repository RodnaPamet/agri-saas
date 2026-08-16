/**
 * Unit Test: ag field-workflow usecases publish automation events.
 *
 * The observability epic already writes SPRAY_JOB_STARTED /
 * OPERATION_PARCEL_MARKED / HARVEST_YIELD_RECORDED to the audit log;
 * this proves the Epic-60 automation emits added alongside those audit
 * writes fire on the bus with the right event + payload, so a tenant
 * rule can trigger on them — without a real DB.
 */

jest.mock('@/lib/audit', () => ({
    appendAuditEntry: jest.fn().mockResolvedValue(undefined),
}));

const mockDb: Record<string, unknown> = {};
jest.mock('@/lib/db-context', () => {
    const actual = jest.requireActual('@/lib/db-context');
    return {
        ...actual,
        runInTenantContext: jest.fn(async (_ctx: unknown, cb: (db: unknown) => unknown) => cb(mockDb)),
    };
});

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: (s: string) => s,
    sanitizeRichTextHtml: (s: string) => s,
}));

// field-operation cross-usecase / repo deps (only createTask + the two
// repos are exercised on the SPRAY path; recordInputApplication +
// auto-evidence are stubbed so the module import is cheap).
jest.mock('@/app-layer/usecases/task', () => ({ createTask: jest.fn() }));
jest.mock('@/app-layer/usecases/inventory', () => ({ recordInputApplication: jest.fn() }));
jest.mock('@/app-layer/repositories/ParcelRepository', () => ({
    ParcelRepository: { validIdsForLocation: jest.fn() },
}));
jest.mock('@/app-layer/repositories/WorkItemRepository', () => ({
    WorkItemRepository: { setStatus: jest.fn() },
    TaskLinkRepository: { link: jest.fn() },
}));
jest.mock('@/app-layer/jobs/queue', () => ({ enqueue: jest.fn() }));

import { createYieldRecord } from '@/app-layer/usecases/yield-record';
import { enqueue } from '@/app-layer/jobs/queue';
import {
    createFieldOperation,
    markOperationParcel,
    resolveOperationType,
} from '@/app-layer/usecases/field-operation';
import { createTask } from '@/app-layer/usecases/task';
import { recordInputApplication } from '@/app-layer/usecases/inventory';
import { ParcelRepository } from '@/app-layer/repositories/ParcelRepository';
import { TaskLinkRepository } from '@/app-layer/repositories/WorkItemRepository';
import {
    getAutomationBus,
    resetAutomationBus,
    type AutomationDomainEvent,
} from '@/app-layer/automation';
import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';

function makeCtx(): RequestContext {
    return {
        requestId: 'req-ag',
        userId: 'user-1',
        tenantId: 'tenant-A',
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

function capture(event: AutomationDomainEvent['event']): AutomationDomainEvent[] {
    const out: AutomationDomainEvent[] = [];
    getAutomationBus().subscribe(event, (e) => {
        out.push(e);
    });
    return out;
}

describe('ag field-workflow usecase emission', () => {
    beforeEach(() => {
        resetAutomationBus();
        jest.clearAllMocks();
        for (const k of Object.keys(mockDb)) delete mockDb[k];
    });

    test('createYieldRecord publishes HARVEST_YIELD_RECORDED', async () => {
        mockDb.yieldRecord = {
            create: jest.fn().mockResolvedValue({
                id: 'yr-1',
                commodity: 'Wheat',
                harvestedAt: new Date('2026-06-17'),
                grossTonnes: 42,
                moisturePct: null,
                areaHa: 10,
                valuationNotes: null,
                plantingId: null,
                locationId: null,
                seasonId: null,
                planting: null,
                location: null,
                season: null,
                createdAt: new Date(),
            }),
        };

        const captured = capture('HARVEST_YIELD_RECORDED');
        await createYieldRecord(makeCtx(), {
            commodity: 'Wheat',
            grossTonnes: 42,
            areaHa: 10,
            harvestedAt: '2026-06-17',
        });

        expect(captured).toHaveLength(1);
        const evt = captured[0];
        expect(evt.event).toBe('HARVEST_YIELD_RECORDED');
        expect(evt.tenantId).toBe('tenant-A');
        expect(evt.entityId).toBe('yr-1');
        if (evt.event === 'HARVEST_YIELD_RECORDED') {
            expect(evt.data).toEqual({
                yieldRecordId: 'yr-1',
                commodity: 'Wheat',
                grossTonnes: 42,
                areaHa: 10,
                plantingId: null,
                seasonId: null,
            });
        }
    });

    test('markOperationParcel publishes OPERATION_PARCEL_MARKED', async () => {
        mockDb.operationParcel = {
            findFirst: jest.fn().mockResolvedValue({
                id: 'op-1',
                parcelId: 'p-1',
                productItemId: 'item-1',
                doseValue: 2,
                doseUnitId: 'u-1',
                status: 'PENDING',
                task: { id: 'task-1', assigneeUserId: 'user-1', status: 'OPEN', key: 'FOP-1' },
            }),
            update: jest.fn().mockResolvedValue({}),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            count: jest.fn().mockResolvedValue(1), // a PENDING parcel remains → no auto-resolve
        };

        const captured = capture('OPERATION_PARCEL_MARKED');
        await markOperationParcel(makeCtx(), 'task-1', 'op-1', 'SKIPPED');

        expect(captured).toHaveLength(1);
        const evt = captured[0];
        expect(evt.entityId).toBe('op-1');
        expect(evt.stableKey).toBe('op-1:SKIPPED');
        if (evt.event === 'OPERATION_PARCEL_MARKED') {
            expect(evt.data).toEqual({
                taskId: 'task-1',
                operationParcelId: 'op-1',
                parcelId: 'p-1',
                status: 'SKIPPED',
                jobResolved: false,
            });
        }
    });

    test('createFieldOperation publishes SPRAY_JOB_STARTED', async () => {
        (createTask as jest.Mock).mockResolvedValue({ id: 'task-1', key: 'FOP-1' });
        (ParcelRepository.validIdsForLocation as jest.Mock).mockResolvedValue(new Set(['p-1', 'p-2']));
        (TaskLinkRepository.link as jest.Mock).mockResolvedValue(undefined);
        mockDb.location = { findFirst: jest.fn().mockResolvedValue({ id: 'loc-1', name: 'North Field' }) };
        mockDb.item = { findFirst: jest.fn().mockResolvedValue({ id: 'item-1' }) };
        mockDb.unit = { findUnique: jest.fn().mockResolvedValue({ id: 'u-1' }) };
        mockDb.operationParcel = { createMany: jest.fn().mockResolvedValue({}) };
        // createFieldOperation now persists operationType + applicationTechnique
        // on the Task via db.task.update inside the same tenant tx.
        mockDb.task = { update: jest.fn().mockResolvedValue({}) };

        const captured = capture('SPRAY_JOB_STARTED');
        await createFieldOperation(makeCtx(), 'loc-1', {
            assigneeUserId: 'user-2',
            parcelIds: ['p-1', 'p-2'],
            productItemId: 'item-1',
            doseValue: 2,
            doseUnitId: 'u-1',
            operationType: 'SPRAY',
            applicationTechnique: 'Гръбна пръскачка',
        });

        expect(captured).toHaveLength(1);
        const evt = captured[0];
        expect(evt.entityId).toBe('task-1');
        if (evt.event === 'SPRAY_JOB_STARTED') {
            expect(evt.data).toEqual({
                taskId: 'task-1',
                taskKey: 'FOP-1',
                locationId: 'loc-1',
                operationType: 'SPRAY',
                parcelCount: 2,
                productItemId: 'item-1',
                assigneeUserId: 'user-2',
            });
        }
        // operationType + technique persisted on the Task.
        expect((mockDb.task as { update: jest.Mock }).update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'task-1' },
                data: expect.objectContaining({
                    operationType: 'SPRAY',
                    applicationTechnique: 'Гръбна пръскачка',
                }),
            }),
        );
    });
});

/**
 * БАБХ farm-record (PR1) — proves the completion snapshot on markOperationParcel
 * and the derive-from-title reader fallback.
 */
describe('farm-record completion snapshot + operation-type reader', () => {
    beforeEach(() => {
        resetAutomationBus();
        jest.clearAllMocks();
        for (const k of Object.keys(mockDb)) delete mockDb[k];
    });

    test('markOperationParcel freezes certs + technique into INPUT_APPLICATION conditionsJson on DONE', async () => {
        (recordInputApplication as jest.Mock).mockResolvedValue({ journalEntryId: 'le-1' });
        const logUpdate = jest.fn().mockResolvedValue({});
        mockDb.operationParcel = {
            findFirst: jest.fn().mockResolvedValue({
                id: 'op-1',
                parcelId: 'p-1',
                productItemId: 'item-1',
                doseValue: 2,
                doseUnitId: 'u-1',
                status: 'PENDING',
                task: {
                    id: 'task-1',
                    assigneeUserId: 'user-2',
                    status: 'OPEN',
                    key: 'FOP-1',
                    applicationTechnique: 'Гръбна пръскачка',
                },
            }),
            update: jest.fn().mockResolvedValue({}),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            count: jest.fn().mockResolvedValue(1), // a PENDING line remains → no auto-resolve noise
        };
        mockDb.tenantMembership = {
            findUnique: jest.fn().mockResolvedValue({
                applicatorCertNo: 'APP-123',
                agronomistCertNo: 'AGR-456',
                agronomistName: 'Иван Петров',
            }),
        };
        mockDb.logEntry = {
            findUnique: jest.fn().mockResolvedValue({ conditionsJson: { windSpeed: 5 } }),
            update: logUpdate,
        };

        await markOperationParcel(makeCtx(), 'task-1', 'op-1', 'DONE');

        // Read the applicator's (assignee's) membership certs.
        expect((mockDb.tenantMembership as { findUnique: jest.Mock }).findUnique).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { tenantId_userId: { tenantId: 'tenant-A', userId: 'user-2' } },
            }),
        );
        // Merge (preserve prior conditions) + freeze the snapshot.
        expect(logUpdate).toHaveBeenCalledWith({
            where: { id: 'le-1' },
            data: {
                conditionsJson: {
                    windSpeed: 5,
                    operatorCertNo: 'APP-123',
                    agronomistName: 'Иван Петров',
                    agronomistCertNo: 'AGR-456',
                    applicationTechnique: 'Гръбна пръскачка',
                },
            },
        });
    });

    test('no snapshot when the line is not newly DONE (no INPUT_APPLICATION)', async () => {
        (recordInputApplication as jest.Mock).mockResolvedValue(null);
        const logUpdate = jest.fn();
        mockDb.operationParcel = {
            findFirst: jest.fn().mockResolvedValue({
                id: 'op-1',
                parcelId: 'p-1',
                productItemId: 'item-1',
                doseValue: 2,
                doseUnitId: 'u-1',
                status: 'PENDING',
                task: { id: 'task-1', assigneeUserId: 'user-2', status: 'OPEN', key: 'FOP-1', applicationTechnique: null },
            }),
            update: jest.fn().mockResolvedValue({}),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            count: jest.fn().mockResolvedValue(1),
        };
        mockDb.logEntry = { findUnique: jest.fn(), update: logUpdate };
        mockDb.tenantMembership = { findUnique: jest.fn() };

        await markOperationParcel(makeCtx(), 'task-1', 'op-1', 'SKIPPED');
        expect(logUpdate).not.toHaveBeenCalled();
    });

    test('resolveOperationType prefers persisted type, falls back to the title prefix', () => {
        expect(resolveOperationType({ operationType: 'FERTILIZE', title: 'Spray — X' })).toBe('FERTILIZE');
        expect(resolveOperationType({ operationType: null, title: 'Fertilize — North' })).toBe('FERTILIZE');
        expect(resolveOperationType({ operationType: null, title: 'Spray — North' })).toBe('SPRAY');
        expect(resolveOperationType({ operationType: null, title: 'Seed — North' })).toBe('SEED');
        expect(resolveOperationType({ operationType: null, title: 'Mystery job' })).toBe('OTHER');
        expect(resolveOperationType({ operationType: undefined, title: undefined })).toBe('OTHER');
    });

    test('enqueues farm-record-pdf (deduped by taskId) when the job auto-resolves', async () => {
        (recordInputApplication as jest.Mock).mockResolvedValue(null);
        mockDb.operationParcel = {
            findFirst: jest.fn().mockResolvedValue({
                id: 'op-1',
                parcelId: 'p-1',
                productItemId: 'item-1',
                doseValue: 2,
                doseUnitId: 'u-1',
                status: 'PENDING',
                task: { id: 'task-1', assigneeUserId: 'user-2', status: 'OPEN', key: 'FOP-1', applicationTechnique: null },
            }),
            update: jest.fn().mockResolvedValue({}),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            count: jest.fn().mockResolvedValue(0), // no PENDING lines left → auto-resolve
        };

        await markOperationParcel(makeCtx(), 'task-1', 'op-1', 'DONE');

        expect(enqueue).toHaveBeenCalledWith(
            'farm-record-pdf',
            { tenantId: 'tenant-A', taskId: 'task-1' },
            // jobId uses '-' not ':' — BullMQ rejects ':' in custom ids.
            { jobId: 'farm-record-task-1' },
        );
    });

    test('does NOT enqueue farm-record-pdf while the job is still open', async () => {
        (recordInputApplication as jest.Mock).mockResolvedValue(null);
        mockDb.operationParcel = {
            findFirst: jest.fn().mockResolvedValue({
                id: 'op-1',
                parcelId: 'p-1',
                productItemId: 'item-1',
                doseValue: 2,
                doseUnitId: 'u-1',
                status: 'PENDING',
                task: { id: 'task-1', assigneeUserId: 'user-2', status: 'OPEN', key: 'FOP-1', applicationTechnique: null },
            }),
            update: jest.fn().mockResolvedValue({}),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            count: jest.fn().mockResolvedValue(2), // PENDING lines remain → no resolve
        };

        await markOperationParcel(makeCtx(), 'task-1', 'op-1', 'DONE');

        expect(enqueue).not.toHaveBeenCalled();
    });
});
