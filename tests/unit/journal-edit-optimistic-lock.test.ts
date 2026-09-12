/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles mirror
 * runtime contracts; the codebase's standard file-level disable. */
/**
 * #919 — journal edits queue offline, guarded by an optimistic lock.
 *
 * Creating an entry has queued through the outbox for a while; EDITING one did
 * not, so an operator who corrected a spray rate in a field lost the
 * correction. The route documented that as a decision and named its own
 * revisit condition — "revisit when journal edits start going through the
 * outbox" — which this change satisfies.
 *
 * It could not simply be queued. TWO preconditions had to land first, and both
 * were invisible from the UI:
 *
 *   - no optimistic lock, so a replay clobbers whatever a supervisor changed
 *     in between with no way to detect it;
 *   - the route read no `Idempotency-Key`, though the outbox has always SENT
 *     one — the same precondition that made #898 dangerous rather than merely
 *     incomplete.
 */
const mockDb: any = {
    logEntry: { updateMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_c: any, fn: any) => fn(mockDb),
    __esModule: true,
}));

const getById = jest.fn();
const updateLogEntryRepo = jest.fn(async (..._a: any[]) => ({ id: 'e1', type: 'OBSERVATION', title: 't', status: 'DONE' }));
jest.mock('../../src/app-layer/repositories/JournalRepository', () => ({
    JournalRepository: {
        getById: (...a: any[]) => getById(...a),
        updateLogEntry: (...a: any[]) => updateLogEntryRepo(...a),
        validLocationIds: jest.fn(async () => new Set<string>()),
        validEquipmentIds: jest.fn(async () => new Set<string>()),
        validParcelIds: jest.fn(async () => new Set<string>()),
    },
}));
jest.mock('../../src/app-layer/repositories/FileRepository', () => ({ FileRepository: {} }));
jest.mock('../../src/app-layer/policies/common', () => ({
    assertCanRead: jest.fn(), assertCanWrite: jest.fn(), assertCanAdmin: jest.fn(),
}));
const logEvent = jest.fn();
jest.mock('../../src/app-layer/events/audit', () => ({ logEvent: (...a: any[]) => logEvent(...a) }));
jest.mock('../../src/app-layer/automation', () => ({ emitAutomationEvent: jest.fn() }));
jest.mock('../../src/app-layer/usecases/inventory', () => ({ recordHarvestLot: jest.fn() }));
jest.mock('../../src/app-layer/usecases/yield-record', () => ({ recordYieldFromHarvest: jest.fn() }));
jest.mock('../../src/app-layer/usecases/crop-planning', () => ({ advancePlantingStatusForLinks: jest.fn() }));
jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: (v: string) => v, sanitizeRichTextHtml: (v: string) => v,
}));
jest.mock('@/lib/observability', () => ({
    traceAgUsecase: (_n: string, _c: any, fn: any) => fn(),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { updateLogEntry } from '@/app-layer/usecases/journal';

const CTX: any = { tenantId: 'tenant-1', userId: 'u1', permissions: { canWrite: true } };
const BODY: any = { title: 'Corrected rate' };
const EXISTING = { id: 'e1', tenantId: 'tenant-1', title: 'old', type: 'OBSERVATION', status: 'DONE' };

beforeEach(() => {
    jest.clearAllMocks();
    getById.mockResolvedValue(EXISTING);
    mockDb.logEntry.updateMany.mockResolvedValue({ count: 1 });
});

describe('a queued edit cannot clobber a change made while you were offline', () => {
    it('claims the row on the version the operator saw', async () => {
        await updateLogEntry(CTX, 'e1', BODY, 3, 'outbox-1');
        expect(mockDb.logEntry.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ id: 'e1', tenantId: 'tenant-1', version: 3 }),
            }),
        );
    });

    it('409s when somebody else moved the row', async () => {
        mockDb.logEntry.updateMany.mockResolvedValue({ count: 0 });
        mockDb.logEntry.findFirst.mockResolvedValue({ version: 7, lastMutationId: 'someone-else' });

        await expect(updateLogEntry(CTX, 'e1', BODY, 3, 'outbox-1'))
            .rejects.toMatchObject({ code: 'STALE_DATA' });
        // And it must NOT have written anything.
        expect(updateLogEntryRepo).not.toHaveBeenCalled();
    });

    it('does NOT write a second time on a replay of the operator OWN applied edit', async () => {
        // The replay carries the version seen BEFORE their write landed, so the
        // guard fails on their own success. Treating that as a conflict asks
        // them to resolve keep-mine vs take-server against themselves.
        mockDb.logEntry.updateMany.mockResolvedValue({ count: 0 });
        mockDb.logEntry.findFirst.mockResolvedValue({ version: 4, lastMutationId: 'outbox-1' });

        const res: any = await updateLogEntry(CTX, 'e1', BODY, 3, 'outbox-1');

        expect(res).toEqual(EXISTING);
        expect(updateLogEntryRepo).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('records the mutation id so the NEXT replay can recognise itself', async () => {
        await updateLogEntry(CTX, 'e1', BODY, 3, 'outbox-1');
        expect(mockDb.logEntry.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ lastMutationId: 'outbox-1' }),
            }),
        );
    });

    it('bumps the version so a later stale replay is rejected', async () => {
        await updateLogEntry(CTX, 'e1', BODY, 3, 'outbox-1');
        expect(mockDb.logEntry.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ version: { increment: 1 } }),
            }),
        );
    });

    it('CONTROL: an ONLINE edit with no If-Match is unguarded, as before', async () => {
        // Without this the change would silently break every online edit from
        // the modal, which sends no version.
        await updateLogEntry(CTX, 'e1', BODY);
        expect(mockDb.logEntry.updateMany).not.toHaveBeenCalled();
        expect(updateLogEntryRepo).toHaveBeenCalledTimes(1);
    });

    it('CONTROL: a guarded edit that CLAIMS the row still performs the write', async () => {
        // Otherwise every assertion above holds for a build that never writes.
        await updateLogEntry(CTX, 'e1', BODY, 3, 'outbox-1');
        expect(updateLogEntryRepo).toHaveBeenCalledTimes(1);
        expect(logEvent).toHaveBeenCalled();
    });
});
