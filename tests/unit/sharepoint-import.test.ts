/* eslint-disable @typescript-eslint/no-explicit-any -- test-mock pattern. */
/**
 * SP-3 — SharePoint → evidence import + delta sync. The Graph client,
 * uploadEvidenceFile, and the DB are mocked; this locks the import loop
 * (download → upload → mapping upsert), the cap, per-item error isolation, and
 * the delta-sync change/delete handling.
 */
const mockUpload = jest.fn();
const mockGetClient = jest.fn();
const mockDb = {
    integrationSyncMapping: { upsert: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    integrationConnection: { findFirst: jest.fn(), update: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_ctx: any, fn: (db: any) => any) => fn(mockDb),
}));
jest.mock('@/app-layer/usecases/evidence', () => ({
    __esModule: true,
    uploadEvidenceFile: (...a: unknown[]) => mockUpload(...a),
}));
jest.mock('@/app-layer/integrations/providers/sharepoint/service', () => ({
    __esModule: true,
    getSharePointClient: (...a: unknown[]) => mockGetClient(...a),
}));
jest.mock('@/lib/observability/edge-logger', () => ({
    __esModule: true,
    edgeLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { importSharePointItems, runSharePointDeltaSync, SP_IMPORT_MAX_ITEMS } from '@/app-layer/integrations/providers/sharepoint/import';

const ctx = { tenantId: 't1', userId: 'u1', permissions: { canWrite: true } } as any;

function fakeClient(over: any = {}) {
    return {
        getItem: jest.fn(async (_d: string, itemId: string) => ({
            id: itemId,
            name: `${itemId}.pdf`,
            file: { mimeType: 'application/pdf' },
            eTag: `etag-${itemId}`,
            webUrl: `https://sp/${itemId}`,
            lastModifiedDateTime: '2026-01-01T00:00:00Z',
        })),
        downloadItemContent: jest.fn(async () => new ArrayBuffer(8)),
        getDelta: jest.fn(async () => ({ items: [], deltaToken: 'TK' })),
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockUpload.mockResolvedValue({ id: 'ev-new' });
    mockDb.integrationSyncMapping.upsert.mockResolvedValue({});
    mockDb.integrationConnection.findFirst.mockResolvedValue({ configJson: {} });
    mockDb.integrationConnection.update.mockResolvedValue({});
});

describe('importSharePointItems', () => {
    it('downloads, uploads, and maps each item', async () => {
        mockGetClient.mockResolvedValue(fakeClient());
        const r = await importSharePointItems(ctx, {
            connectionId: 'c1',
            items: [{ driveId: 'd1', itemId: 'a' }, { driveId: 'd1', itemId: 'b' }],
            practiceId: 'ctrl1',
        });
        expect(r.imported).toBe(2);
        expect(r.failed).toBe(0);
        expect(mockUpload).toHaveBeenCalledTimes(2);
        expect(mockUpload.mock.calls[0][2]).toMatchObject({ practiceId: 'ctrl1' });
        expect(mockDb.integrationSyncMapping.upsert).toHaveBeenCalledTimes(2);
        // mapping carries the SharePoint webUrl as sourceUrl
        const upsertArg = mockDb.integrationSyncMapping.upsert.mock.calls[0][0];
        expect(upsertArg.create.sourceUrl).toBe('https://sp/a');
        expect(upsertArg.create.remoteEntityId).toBe('d1:a');
    });

    it('isolates per-item failures', async () => {
        const client = fakeClient();
        client.downloadItemContent.mockRejectedValueOnce(new Error('graph 500'));
        mockGetClient.mockResolvedValue(client);
        const r = await importSharePointItems(ctx, {
            connectionId: 'c1',
            items: [{ driveId: 'd1', itemId: 'a' }, { driveId: 'd1', itemId: 'b' }],
        });
        expect(r.imported).toBe(1);
        expect(r.failed).toBe(1);
        expect(r.errors[0].itemId).toBe('a');
    });

    it('rejects oversized batches', async () => {
        mockGetClient.mockResolvedValue(fakeClient());
        const items = Array.from({ length: SP_IMPORT_MAX_ITEMS + 1 }, (_, i) => ({ driveId: 'd1', itemId: String(i) }));
        await expect(importSharePointItems(ctx, { connectionId: 'c1', items })).rejects.toThrow(/at most/i);
    });

    it('no-ops on an empty selection', async () => {
        const r = await importSharePointItems(ctx, { connectionId: 'c1', items: [] });
        expect(r).toEqual({ imported: 0, failed: 0, evidenceIds: [], errors: [] });
    });
});

describe('runSharePointDeltaSync', () => {
    it('re-imports changed files (eTag differs) and marks deleted ones stale', async () => {
        mockDb.integrationSyncMapping.findMany.mockResolvedValue([
            { id: 'm1', remoteEntityId: 'd1:a', remoteDataJson: { eTag: 'old' }, localEntityId: 'ev1' },
            { id: 'm2', remoteEntityId: 'd1:b', remoteDataJson: { eTag: 'same' }, localEntityId: 'ev2' },
            { id: 'm3', remoteEntityId: 'd1:c', remoteDataJson: { eTag: 'x' }, localEntityId: 'ev3' },
        ]);
        const client = fakeClient({
            getDelta: jest.fn(async () => ({
                items: [
                    { id: 'a', eTag: 'NEW', file: { mimeType: 'application/pdf' }, name: 'a.pdf' }, // changed
                    { id: 'b', eTag: 'same' }, // unchanged
                    { id: 'c', deleted: { state: 'deleted' } }, // deleted
                ],
                deltaToken: 'TK2',
            })),
        });
        mockGetClient.mockResolvedValue(client);

        const r = await runSharePointDeltaSync(ctx, 'c1');
        expect(r.drivesSynced).toBe(1);
        expect(r.reimported).toBe(1); // only 'a'
        expect(r.staled).toBe(1); // only 'c'
        // 'c' marked STALE
        expect(mockDb.integrationSyncMapping.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'm3' }, data: expect.objectContaining({ syncStatus: 'STALE' }) }),
        );
        // new delta token persisted
        expect(mockDb.integrationConnection.update).toHaveBeenCalled();
    });

    it('uses cTag (content tag) — a metadata-only eTag bump does NOT re-import', async () => {
        mockDb.integrationSyncMapping.findMany.mockResolvedValue([
            { id: 'm1', remoteEntityId: 'd1:a', remoteDataJson: { cTag: 'C1', eTag: 'E1' }, localEntityId: 'ev1' },
            { id: 'm2', remoteEntityId: 'd1:b', remoteDataJson: { cTag: 'C1', eTag: 'E1' }, localEntityId: 'ev2' },
        ]);
        const client = fakeClient({
            getDelta: jest.fn(async () => ({
                items: [
                    { id: 'a', cTag: 'C1', eTag: 'E2', file: { mimeType: 'application/pdf' }, name: 'a.pdf' }, // metadata touch only
                    { id: 'b', cTag: 'C2', eTag: 'E2', file: { mimeType: 'application/pdf' }, name: 'b.pdf' }, // content changed
                ],
                deltaToken: 'TK',
            })),
        });
        mockGetClient.mockResolvedValue(client);
        const r = await runSharePointDeltaSync(ctx, 'c1');
        expect(r.reimported).toBe(1); // only 'b' (cTag changed); 'a' (eTag-only) skipped
    });
});
