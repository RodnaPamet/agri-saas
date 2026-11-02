/**
 * «Прочети брошура» — the leaflet scan usecase (#2664).
 *
 * The property worth protecting is what this does NOT do: it creates no
 * `Promotion`. The read PROPOSES and a person confirms, because a misread
 * price or end date would be repeated to farmers as fact by the assistant —
 * a sharper version of why `invoice-scan` creates no cost entry.
 *
 * The order of the gates is the other one. The spend assertion runs BEFORE
 * the upload, so a month with no budget left does not leave a stored
 * `FileRecord` nothing can propose from; and usage is recorded on BOTH the
 * success and the failure paths, because a document the model could not read
 * still spent tokens.
 */
const isPlatformAiSpendAllowed = jest.fn<Promise<boolean>, unknown[]>(async () => true);
const recordPlatformAiUsage = jest.fn<Promise<void>, unknown[]>(async () => undefined);
jest.mock('@/app-layer/ai/platform-budget', () => ({
    isPlatformAiSpendAllowed: (...a: unknown[]) => isPlatformAiSpendAllowed(...a),
    // Still doubled even though the USECASE no longer calls it: the assertion
    // below that it was NOT called is what proves the ledger write did not
    // quietly come back to this layer and start double-counting.
    recordPlatformAiUsage: (...a: unknown[]) => recordPlatformAiUsage(...a),
}));

const readPromotionLeaflet = jest.fn<Promise<unknown>, unknown[]>();
const leafletReaderAvailable = jest.fn<boolean, unknown[]>(() => true);
jest.mock('@/app-layer/ai/promotion-leaflet-reader', () => ({
    readPromotionLeaflet: (...a: unknown[]) => readPromotionLeaflet(...a),
    leafletReaderAvailable: () => leafletReaderAvailable(),
    // The REAL predicate, not a double: which media can be read is the thing
    // the XLSX case below is about, and a stubbed `true` would make that test
    // assert the stub.
    isReadableLeafletMedia: jest.requireActual('@/app-layer/ai/promotion-leaflet-reader')
        .isReadableLeafletMedia,
}));

const ingestUploadedFile = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('@/lib/upload/ingest', () => ({
    ingestUploadedFile: (...a: unknown[]) => ingestUploadedFile(...a),
}));

const createPending = jest.fn<Promise<{ id: string }>, unknown[]>(async () => ({ id: 'file-1' }));
const markStored = jest.fn<Promise<void>, unknown[]>(async () => undefined);
jest.mock('@/app-layer/repositories/FileRepository', () => ({
    FileRepository: {
        createPending: (...a: unknown[]) => createPending(...a),
        markStored: (...a: unknown[]) => markStored(...a),
    },
}));

const promotionCreate = jest.fn();
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: async (_ctx: unknown, fn: (db: unknown) => Promise<unknown>) =>
        fn({ promotion: { create: promotionCreate } }),
}));

import { scanPromotionLeaflet } from '@/app-layer/usecases/promotion-leaflet-scan';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('ADMIN');
const file = () => new File([new Uint8Array([1, 2, 3])], 'leaflet.pdf', { type: 'application/pdf' });

const ingestOf = (mimeType: string) => ({
    pathKey: 'promotion-leaflet/t1/leaflet.pdf',
    originalName: 'leaflet.pdf',
    mimeType,
    sizeBytes: 3,
    sha256: 'abc',
    storageProvider: 'local',
    bucket: null,
    domain: 'promotion-leaflet',
    scanStatus: 'CLEAN',
    buffer: Buffer.from([1, 2, 3]),
});

const GOOD_READ = {
    refused: false,
    read: {
        isLeaflet: true,
        companyName: 'Агро Търговия ООД',
        offers: [
            { productName: 'Амониев нитрат', priceText: 'от 1 200 лв./т', validityText: null, note: null },
        ],
        unreadableOfferCount: 1,
    },
    usage: { model: 'claude-sonnet-4-6', promptTokens: 900, completionTokens: 70, totalTokens: 970 },
};

beforeEach(() => {
    jest.clearAllMocks();
    isPlatformAiSpendAllowed.mockResolvedValue(true);
    leafletReaderAvailable.mockReturnValue(true);
    createPending.mockResolvedValue({ id: 'file-1' });
    ingestUploadedFile.mockResolvedValue(ingestOf('application/pdf'));
    readPromotionLeaflet.mockResolvedValue(GOOD_READ);
});

describe('scanPromotionLeaflet (#2664)', () => {
    it('returns a proposal and creates NO promotion', async () => {
        const result = await scanPromotionLeaflet(ctx, { file: file() });

        expect(result).toEqual({
            fileId: 'file-1',
            companyName: 'Агро Търговия ООД',
            offers: GOOD_READ.read.offers,
            // Surfaced, not swallowed: a six-offer leaflet read as five is
            // otherwise indistinguishable from a five-offer leaflet.
            unreadableOfferCount: 1,
        });
        // THE assertion of this file. A row here would mean a model-read price
        // reaching farmers without anybody confirming it.
        expect(promotionCreate).not.toHaveBeenCalled();
        // And the ledger is written ONCE, in the reader. A call from here too
        // would double-count every leaflet against the platform budget.
        expect(recordPlatformAiUsage).not.toHaveBeenCalled();
    });

    it('asserts the budget BEFORE storing anything', async () => {
        isPlatformAiSpendAllowed.mockResolvedValue(false);

        await expect(scanPromotionLeaflet(ctx, { file: file() })).rejects.toMatchObject({
            code: 'PLATFORM_AI_BUDGET_EXCEEDED',
        });
        // Not merely "it refused": refusing after the upload would leave a
        // stored FileRecord that nothing can ever propose from.
        expect(ingestUploadedFile).not.toHaveBeenCalled();
        expect(createPending).not.toHaveBeenCalled();
    });

    it('stores a workbook and refuses to READ it, naming the stored file', async () => {
        // The owner asked to upload PDF, Excel or a photo. There is no
        // spreadsheet block in the Messages API, so the honest answer is
        // "stored — type it in" rather than an empty read, which would look
        // exactly like a leaflet with no offers on it.
        ingestUploadedFile.mockResolvedValue(
            ingestOf('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
        );

        await expect(scanPromotionLeaflet(ctx, { file: file() })).rejects.toMatchObject({
            code: 'LEAFLET_MEDIA_UNSUPPORTED',
            params: { leafletFileId: 'file-1' },
        });
        // Stored first — the bytes went through the AV scan and are keepable.
        expect(markStored).toHaveBeenCalledWith(expect.anything(), ctx, 'file-1', 'CLEAN');
        // And no tokens spent on something that cannot be sent.
        expect(readPromotionLeaflet).not.toHaveBeenCalled();
        expect(recordPlatformAiUsage).not.toHaveBeenCalled();
    });

    it('turns an unusable read into LEAFLET_NOT_RECOGNISED, naming the stored file', async () => {
        // The LEDGER is not asserted here, and that is deliberate: it moved
        // into the reader beside the call it is about, and the reader is
        // mocked in this file. `promotion-leaflet-reader.test.ts` is where
        // "an unusable read still pays" is proved.
        readPromotionLeaflet.mockResolvedValue({
            read: null,
            usage: { model: 'claude-sonnet-4-6', promptTokens: 800, completionTokens: 0, totalTokens: 800 },
            refused: false,
        });

        await expect(scanPromotionLeaflet(ctx, { file: file() })).rejects.toMatchObject({
            code: 'LEAFLET_NOT_RECOGNISED',
            params: { leafletFileId: 'file-1' },
        });
    });

    it('treats "this is not a leaflet" as the SAME refusal as an unreadable one', async () => {
        // Same code, because the remedy is the same for the operator: the
        // file is stored, type the offers in. The CAUSE differs and goes to
        // the log, for whoever tunes the prompt.
        readPromotionLeaflet.mockResolvedValue({
            read: { isLeaflet: false, companyName: null, offers: [], unreadableOfferCount: 0 },
            usage: { model: 'claude-sonnet-4-6', promptTokens: 700, completionTokens: 20, totalTokens: 720 },
            refused: false,
        });

        await expect(scanPromotionLeaflet(ctx, { file: file() })).rejects.toMatchObject({
            code: 'LEAFLET_NOT_RECOGNISED',
        });
    });

    it('separates a budget refusal MID-REQUEST from an unusable read', async () => {
        // The month's last tokens going during a long upload. A different code
        // because the remedies differ — wait or raise the ceiling, versus
        // retype a leaflet that would have read perfectly tomorrow.
        readPromotionLeaflet.mockResolvedValue({
            read: null,
            usage: { model: 'claude-sonnet-4-6', promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            refused: true,
        });

        await expect(scanPromotionLeaflet(ctx, { file: file() })).rejects.toMatchObject({
            code: 'PLATFORM_AI_BUDGET_EXCEEDED',
            params: { leafletFileId: 'file-1' },
        });
    });

    it('says so plainly when no key is configured', async () => {
        leafletReaderAvailable.mockReturnValue(false);

        await expect(scanPromotionLeaflet(ctx, { file: file() })).rejects.toMatchObject({
            code: 'LEAFLET_READER_UNAVAILABLE',
            status: 503,
        });
        // Nothing stored and no budget consulted: the operator's file is fine
        // and nothing they do will help.
        expect(ingestUploadedFile).not.toHaveBeenCalled();
        expect(isPlatformAiSpendAllowed).not.toHaveBeenCalled();
    });
});
