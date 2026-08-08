/**
 * RQ-10 follow-up — deliverReportToSharePoint pushes a generated report to a
 * Graph drive via the SP-3 client, with no-op guards. SP client + storage are
 * mocked (no Graph/DB).
 */
const uploadNewFile = jest.fn().mockResolvedValue({ id: 'sp-item-1', webUrl: 'https://sp/item' });

jest.mock('@/app-layer/integrations/providers/sharepoint', () => ({
    listSharePointConnections: jest.fn().mockResolvedValue([{ id: 'conn-1' }]),
    getSharePointClient: jest.fn().mockResolvedValue({ uploadNewFile }),
}));

jest.mock('@/lib/storage', () => ({
    getStorageProvider: () => ({
        // an async-iterable stream of one chunk
        readStream: () => (async function* () { yield Buffer.from('PDFBYTES'); })(),
    }),
    generatePathKey: (t: string, n: string) => `${t}/${n}`,
}));

import { listSharePointConnections } from '@/app-layer/integrations/providers/sharepoint';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext();
const completed = { id: 'r1', outputPath: 'tenant/report.pdf', format: 'PDF', status: 'COMPLETED' };

describe('deliverReportToSharePoint', () => {
    beforeEach(() => uploadNewFile.mockClear());

    it('uploads the artefact to the drive folder + returns the item id', async () => {
        const id = await deliverReportToSharePoint(ctx, completed, 'drive-1', 'folder-9', 'Portfolio, Q2');
        expect(id).toBe('sp-item-1');
        expect(uploadNewFile).toHaveBeenCalledTimes(1);
        const [driveId, folderId, name, body, mime] = uploadNewFile.mock.calls[0];
        expect(driveId).toBe('drive-1');
        expect(folderId).toBe('folder-9');
        expect(name).toBe('Portfolio-Q2-r1.pdf'); // label sanitised (", " → "-")
        expect(Buffer.isBuffer(body)).toBe(true);
        expect(mime).toBe('application/pdf');
    });

    it('defaults the folder to root when none is given', async () => {
        await deliverReportToSharePoint(ctx, completed, 'drive-1', null, 'X');
        expect(uploadNewFile.mock.calls[0][1]).toBe('root');
    });

    it('is a no-op when no driveId is configured', async () => {
        expect(await deliverReportToSharePoint(ctx, completed, null, 'f', 'X')).toBeNull();
        expect(uploadNewFile).not.toHaveBeenCalled();
    });

    it('is a no-op when the run is not COMPLETED', async () => {
        expect(await deliverReportToSharePoint(ctx, { ...completed, status: 'FAILED' }, 'drive-1', 'f', 'X')).toBeNull();
        expect(uploadNewFile).not.toHaveBeenCalled();
    });

    it('is a no-op when the tenant has no SharePoint connection', async () => {
        (listSharePointConnections as jest.Mock).mockResolvedValueOnce([]);
        expect(await deliverReportToSharePoint(ctx, completed, 'drive-1', 'f', 'X')).toBeNull();
        expect(uploadNewFile).not.toHaveBeenCalled();
    });
});
