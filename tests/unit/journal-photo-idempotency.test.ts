/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock pattern. */
/**
 * `uploadLogEntryPhoto` — the REAL usecase, not a route-level spy.
 *
 * A route test that spies on `uploadLogEntryPhoto` proves the route FORWARDS
 * the Idempotency-Key; it says nothing about the usecase doing anything with
 * it. Deleting the `...(idempotencyKey ? { idempotencyKey } : {})` spread at
 * journal.ts:699 leaves such a test green. These drive the real function and
 * assert the key lands in the audit `detailsJson`.
 */
import { Prisma } from '@prisma/client';

const mockDb = { $executeRaw: jest.fn() } as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));
jest.mock('@/app-layer/repositories/JournalRepository', () => ({
    JournalRepository: {
        getById: jest.fn(),
        findFileLink: jest.fn(),
        attachFile: jest.fn(),
        validLocationIds: jest.fn(),
        validEquipmentIds: jest.fn(),
    },
}));
jest.mock('@/app-layer/repositories/FileRepository', () => ({
    FileRepository: { findBySha256: jest.fn(), createPending: jest.fn(), markStored: jest.fn() },
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/app-layer/jobs/queue', () => ({ enqueue: jest.fn() }));

const storage = { name: 'local', write: jest.fn(), delete: jest.fn() };
jest.mock('@/lib/storage', () => ({
    getStorageProvider: () => storage,
    buildTenantObjectKey: (t: string, d: string, n: string) => `${t}/${d}/${n}`,
    isAllowedMime: () => true,
    isAllowedSize: () => true,
    FILE_MAX_SIZE_BYTES: 10_000_000,
}));
jest.mock('@/lib/storage/av-scan', () => ({ scanUploadedBuffer: jest.fn(async () => 'CLEAN') }));

import { JournalRepository } from '@/app-layer/repositories/JournalRepository';
import { FileRepository } from '@/app-layer/repositories/FileRepository';
import { logEvent } from '@/app-layer/events/audit';
import { enqueue } from '@/app-layer/jobs/queue';
import { uploadLogEntryPhoto } from '@/app-layer/usecases/journal';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('EDITOR', { userId: 'user-1', tenantId: 'tenant-1' });
// Real JPEG magic — reconcileMimeType is NOT mocked, so the sniffer agrees
// with the declared type and the `corrected` branch stays cold.
const photo = () => new File([new Uint8Array([0xff, 0xd8, 0xff, 0x00])], 'field.jpg', { type: 'image/jpeg' });

beforeEach(() => {
    jest.clearAllMocks();
    storage.write.mockResolvedValue({ sha256: 'abc123', sizeBytes: 4 });
    (JournalRepository.getById as jest.Mock).mockResolvedValue({ id: 'log-1' });
    (FileRepository.findBySha256 as jest.Mock).mockResolvedValue(null);
    (FileRepository.createPending as jest.Mock).mockResolvedValue({ id: 'file-1' });
    (JournalRepository.findFileLink as jest.Mock).mockResolvedValue(null);
    (JournalRepository.attachFile as jest.Mock).mockResolvedValue({ id: 'link-1', fileRecordId: 'file-1' });
});

describe('uploadLogEntryPhoto — idempotencyKey reaches the audit trail', () => {
    it('spreads the key into the audit detailsJson (kills the delete-line-699 mutant)', async () => {
        await uploadLogEntryPhoto(ctx, 'log-1', photo(), 'aphids on block A', 'outbox-item-42');

        expect(logEvent).toHaveBeenCalledWith(
            mockDb, ctx,
            expect.objectContaining({
                action: 'LOG_ENTRY_FILE_ATTACHED',
                detailsJson: expect.objectContaining({ idempotencyKey: 'outbox-item-42' }),
            }),
        );
    });

    it('omits the key entirely when none was sent', async () => {
        await uploadLogEntryPhoto(ctx, 'log-1', photo(), null, null);

        const entry = (logEvent as jest.Mock).mock.calls[0][2];
        expect(entry.detailsJson).not.toHaveProperty('idempotencyKey');
        expect(entry.detailsJson).toMatchObject({ relation: 'PHOTO', targetId: 'file-1' });
    });

    it('takes the advisory lock on (tenant, content-hash) before the dedup read', async () => {
        await uploadLogEntryPhoto(ctx, 'log-1', photo(), null, 'k');
        expect(mockDb.$executeRaw).toHaveBeenCalled();
        expect(mockDb.$executeRaw.mock.calls[0].slice(1)).toContain('tenant-1:abc123');
    });

    it('replays an already-linked photo — original link, no second attach, no audit, no classify', async () => {
        (FileRepository.findBySha256 as jest.Mock).mockResolvedValue({ id: 'file-1', status: 'STORED' });
        (JournalRepository.findFileLink as jest.Mock).mockResolvedValue({ id: 'link-original' });

        const out = await uploadLogEntryPhoto(ctx, 'log-1', photo(), null, 'outbox-item-42');

        expect(out).toEqual({ id: 'link-original' });
        expect(JournalRepository.attachFile).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
        expect(enqueue).not.toHaveBeenCalled();
        expect(storage.delete).toHaveBeenCalledWith('tenant-1/general/field.jpg');
    });

    it('loses the attach race — re-reads the winner and returns it as exactly-once', async () => {
        (JournalRepository.attachFile as jest.Mock).mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' }),
        );
        // Fresh-record path: findFileLink is consulted ONLY by the
        // unique-violation backstop, so the first call is the winner re-read.
        (JournalRepository.findFileLink as jest.Mock).mockResolvedValue({ id: 'link-winner' });

        const out = await uploadLogEntryPhoto(ctx, 'log-1', photo(), null, 'k');
        expect(out).toEqual({ id: 'link-winner' });
        expect(logEvent).not.toHaveBeenCalled();
    });
});
