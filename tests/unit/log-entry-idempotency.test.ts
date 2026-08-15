/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks and Prisma
 * client shims mirror runtime contracts; per-line typing has poor cost/benefit
 * in test files (the codebase's standard file-level disable). */
/**
 * Offline exactly-once — `createLogEntry` idempotency.
 *
 * The offline outbox re-sends a queued journal entry over flaky rural LTE with
 * its item id as the `Idempotency-Key`. The usecase must dedupe on
 * (tenantId, clientMutationId): a replay returns the ORIGINAL entry with no
 * second row. Mirrors the field-operation (Task) idempotency tests. Locks:
 *   1. replay with a known key short-circuits — createLogEntry is never called;
 *   2. a create WITHOUT a key stamps clientMutationId=null;
 *   3. a create WITH a fresh key stamps clientMutationId=key;
 *   4. a concurrent-replay P2002 race re-reads the winner instead of throwing.
 */
import { Prisma } from '@prisma/client';

const mockDb = {} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: any, fn: any) => fn(mockDb),
}));
const JournalRepository = {
    findByClientMutationId: jest.fn(),
    createLogEntry: jest.fn(),
    validLocationIds: jest.fn(async () => new Set<string>()),
    validEquipmentIds: jest.fn(async () => new Set<string>()),
};
jest.mock('../../src/app-layer/repositories/JournalRepository', () => ({ JournalRepository }));
jest.mock('../../src/app-layer/repositories/FileRepository', () => ({ FileRepository: {} }));
jest.mock('../../src/app-layer/policies/common', () => ({
    assertCanRead: jest.fn(), assertCanWrite: jest.fn(), assertCanAdmin: jest.fn(),
}));
jest.mock('../../src/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('../../src/app-layer/usecases/inventory', () => ({ recordHarvestLot: jest.fn() }));
jest.mock('../../src/app-layer/usecases/auto-evidence', () => ({
    // journal.ts imports BOTH of these; a factory naming only the
    // deleted `attachAutoEvidenceFromLogEntry` would leave them
    // undefined and blow up the update / delete / restore paths.
    syncDerivedEvidenceTitle: jest.fn(),
    setDerivedEvidenceWithdrawn: jest.fn(),
}));
jest.mock('../../src/app-layer/jobs/queue', () => ({ enqueue: jest.fn() }));
jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: (s: string) => s,
    sanitizeRichTextHtml: (s: string) => s,
}));
jest.mock('@/lib/observability', () => ({
    traceAgUsecase: (_n: string, _c: any, fn: any) => fn(),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@opentelemetry/api', () => ({ trace: { getActiveSpan: () => ({ setAttributes: jest.fn() }) } }));

import { createLogEntry } from '../../src/app-layer/usecases/journal';

const ctx: any = { tenantId: 'tenant-1', userId: 'user-1', permissions: { canWrite: true } };
const data: any = { type: 'OBSERVATION', title: 'Scouted aphids on block A', status: 'DONE' };

beforeEach(() => {
    jest.clearAllMocks();
    JournalRepository.validLocationIds.mockResolvedValue(new Set());
    JournalRepository.validEquipmentIds.mockResolvedValue(new Set());
});

describe('createLogEntry idempotency', () => {
    it('replays a known key — returns the original entry, never calls createLogEntry', async () => {
        JournalRepository.findByClientMutationId.mockResolvedValue({ id: 'entry-existing', title: 'Scouted aphids on block A' });

        const result = await createLogEntry(ctx, data, 'outbox-abc');

        expect(result).toEqual({ id: 'entry-existing', title: 'Scouted aphids on block A' });
        expect(JournalRepository.createLogEntry).not.toHaveBeenCalled();
    });

    it('creates without a key — stamps clientMutationId=null', async () => {
        JournalRepository.createLogEntry.mockResolvedValue({ id: 'entry-new', title: data.title });

        await createLogEntry(ctx, data /* no key */);

        expect(JournalRepository.findByClientMutationId).not.toHaveBeenCalled();
        expect(JournalRepository.createLogEntry).toHaveBeenCalledTimes(1);
        expect(JournalRepository.createLogEntry.mock.calls[0][2]).toMatchObject({ clientMutationId: null });
    });

    it('creates with a fresh key — stamps clientMutationId=key', async () => {
        JournalRepository.findByClientMutationId.mockResolvedValue(null); // no prior entry
        JournalRepository.createLogEntry.mockResolvedValue({ id: 'entry-new', title: data.title });

        await createLogEntry(ctx, data, 'outbox-xyz');

        expect(JournalRepository.createLogEntry).toHaveBeenCalledTimes(1);
        expect(JournalRepository.createLogEntry.mock.calls[0][2]).toMatchObject({ clientMutationId: 'outbox-xyz' });
    });

    it('loses a P2002 race — re-reads the winning entry instead of throwing', async () => {
        // First (pre-)lookup: no entry yet. After the create trips the unique
        // index, the backstop lookup finds the winner.
        JournalRepository.findByClientMutationId
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 'entry-winner', title: data.title });
        JournalRepository.createLogEntry.mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }),
        );

        const result = await createLogEntry(ctx, data, 'outbox-race');

        expect(result).toEqual({ id: 'entry-winner', title: data.title });
    });
});
