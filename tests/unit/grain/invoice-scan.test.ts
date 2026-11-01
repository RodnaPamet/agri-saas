/**
 * «Сканирай фактура» — the invoice-scan usecase (#482).
 *
 * Six properties here are CONTRACT rather than behaviour-as-written, which is
 * why they are asserted rather than left to review:
 *
 *   - **Nothing is saved.** The owner's ruling is that the invoice fills the
 *     form and the farmer taps «Запиши». A usecase that booked the lines
 *     itself would put a misread amount into the Калкулатор unseen, and no
 *     later test would notice because the number would be perfectly plausible.
 *   - **`lines` is the batch body's shape, so it posts back unchanged.** The
 *     whole flow dies at the last tap otherwise.
 *   - **Lev is converted at the fixed peg and the original stays visible.**
 *     The save path refuses a non-EUR currency, so a line that kept `BGN`
 *     would 400 on save; and the original figure has no column, so it is
 *     prefixed to the description.
 *   - **Attribution is NULL, always.** The model cannot know which planting a
 *     drum of diesel belongs to.
 *   - **An overflow is REPORTED.** Silently dropping 15 lines of a farmer's
 *     invoice leaves a sheet that looks complete and totals wrong.
 *   - **Usage is recorded even when the read FAILS.** An unreadable document
 *     still spent the tokens, and those are exactly the requests a farmer
 *     retries — so a ledger written only on success undercounts the budget it
 *     is supposed to cap.
 */
import type { RequestContext } from '@/app-layer/types';

const db = {
    fileRecord: { findFirst: jest.fn() },
    farmDocument: { findFirst: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (d: unknown) => unknown) => fn(db),
}));

jest.mock('@/app-layer/policies/common', () => ({ assertCanWrite: jest.fn() }));

const readInvoiceMock = jest.fn();
jest.mock('@/app-layer/ai/invoice-reader', () => ({
    readInvoice: (...a: unknown[]) => readInvoiceMock(...a),
    isReadableInvoiceMedia: () => true,
    invoiceReaderAvailable: () => true,
}));

const assertAiBudgetMock = jest.fn();
jest.mock('@/app-layer/ai/budget', () => ({
    assertAiBudget: (...a: unknown[]) => assertAiBudgetMock(...a),
}));

const recordAiUsageMock = jest.fn();
jest.mock('@/app-layer/ai/usage', () => ({
    recordAiUsage: (...a: unknown[]) => recordAiUsageMock(...a),
}));
jest.mock('@/app-layer/ai/cost', () => ({ estimateCostMicros: () => 0 }));

const ingestMock = jest.fn();
jest.mock('@/lib/upload/ingest', () => ({
    ingestUploadedFile: (...a: unknown[]) => ingestMock(...a),
}));

jest.mock('@/app-layer/repositories/FileRepository', () => ({
    FileRepository: {
        createPending: jest.fn().mockResolvedValue({ id: 'file-1' }),
        markStored: jest.fn(),
    },
}));

jest.mock('@/app-layer/usecases/cost-entry', () => ({ assertUsableInvoice: jest.fn() }));

jest.mock('@/lib/storage', () => ({
    getProviderByName: () => ({
        readStream: () => {
            const { Readable } = jest.requireActual('stream');
            return Readable.from([Buffer.from('PDFBYTES')]);
        },
    }),
}));

jest.mock('@/lib/soft-delete', () => ({ withDeleted: (a: unknown) => a }));

import { scanInvoice } from '@/app-layer/usecases/invoice-scan';

const ctx = (): RequestContext =>
    ({ tenantId: 't-1', userId: 'u-1', role: 'OWNER', permissions: {}, appPermissions: {} }) as unknown as RequestContext;

function draft(over: Record<string, unknown> = {}) {
    return {
        category: 'FUEL',
        amount: 250,
        currency: 'BGN',
        incurredOn: '2026-10-15',
        supplier: 'Петрол АД',
        description: 'Дизел',
        commodity: null,
        ...over,
    };
}

function okRead(lines: Record<string, unknown>[], unreadable = 0) {
    return {
        read: { isInvoice: true, lines, unreadableLineCount: unreadable },
        usage: { model: 'claude-sonnet-4-6', promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    ingestMock.mockResolvedValue({
        pathKey: 'invoices/x.pdf',
        originalName: 'x.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 8,
        sha256: 'abc',
        storageProvider: 'local',
        bucket: null,
        domain: 'invoices',
        scanStatus: 'CLEAN',
    });
    readInvoiceMock.mockResolvedValue(okRead([draft()]));
});

const aFile = () => new File([new Uint8Array([1, 2, 3])], 'inv.pdf', { type: 'application/pdf' });

describe('the input is exactly one of file / fileId', () => {
    it('refuses BOTH with INVOICE_SCAN_INPUT_AMBIGUOUS', async () => {
        await expect(scanInvoice(ctx(), { file: aFile(), fileId: 'f-9' })).rejects.toMatchObject({
            code: 'INVOICE_SCAN_INPUT_AMBIGUOUS',
        });
    });

    it('refuses all THREE with the same code', async () => {
        await expect(
            scanInvoice(ctx(), { file: aFile(), fileId: 'f-9', documentId: 'd-9' }),
        ).rejects.toMatchObject({ code: 'INVOICE_SCAN_INPUT_AMBIGUOUS' });
    });

    it('refuses fileId AND documentId together', async () => {
        await expect(scanInvoice(ctx(), { fileId: 'f-9', documentId: 'd-9' })).rejects.toMatchObject({
            code: 'INVOICE_SCAN_INPUT_AMBIGUOUS',
        });
    });

    it('refuses NEITHER with the same code', async () => {
        // The same code on purpose: both shapes are the same client bug, and
        // the message differs rather than the code.
        await expect(scanInvoice(ctx(), {})).rejects.toMatchObject({
            code: 'INVOICE_SCAN_INPUT_AMBIGUOUS',
        });
    });

    it('spends NOTHING when the input is refused', async () => {
        await expect(scanInvoice(ctx(), {})).rejects.toThrow();
        expect(assertAiBudgetMock).not.toHaveBeenCalled();
        expect(readInvoiceMock).not.toHaveBeenCalled();
    });
});

describe('the proposal', () => {
    it('converts лев at the fixed peg and keeps the original visible', async () => {
        const res = await scanInvoice(ctx(), { file: aFile() });
        expect(res.lines).toHaveLength(1);
        const line = res.lines[0];
        // 250 / 1.95583 = 127.82…
        expect(line.amount).toBeCloseTo(127.82, 2);
        expect(line.currency).toBe('EUR');
        // The original has no column, so it is prefixed to the description.
        expect(line.description).toContain('250.00 лв.');
        expect(line.description).toContain('Дизел');
    });

    it('leaves a EUR invoice alone, with no lev prefix', async () => {
        readInvoiceMock.mockResolvedValue(okRead([draft({ currency: 'EUR', amount: 100 })]));
        const res = await scanInvoice(ctx(), { file: aFile() });
        expect(res.lines[0].amount).toBe(100);
        expect(res.lines[0].description).not.toContain('лв.');
    });

    it('returns every attribution field NULL', async () => {
        const res = await scanInvoice(ctx(), { file: aFile() });
        const line = res.lines[0];
        for (const k of ['plantingId', 'seasonId', 'locationId', 'parcelId', 'leaseId', 'itemId'] as const) {
            expect(line[k]).toBeNull();
        }
        // `commodityCanonical` and `allocationBasis` move TOGETHER or not at
        // all — the schema requires the commodity for CROP and refuses it
        // otherwise, so one without the other would 400 on save.
        expect(line.commodityCanonical).toBeUndefined();
        expect(line.allocationBasis).toBeUndefined();
    });

    it('pre-fills the invoice file id on every line', async () => {
        readInvoiceMock.mockResolvedValue(okRead([draft(), draft({ category: 'SERVICE' })]));
        const res = await scanInvoice(ctx(), { file: aFile() });
        expect(res.lines.map((l) => l.invoiceFileId)).toEqual(['file-1', 'file-1']);
        expect(res.invoiceFileId).toBe('file-1');
    });

    it('REPORTS an overflow past the batch bound rather than truncating silently', async () => {
        readInvoiceMock.mockResolvedValue(okRead(Array.from({ length: 40 }, () => draft())));
        const res = await scanInvoice(ctx(), { file: aFile() });
        expect(res.lines).toHaveLength(25);
        expect(res.warnings).toContainEqual({
            code: 'INVOICE_LINES_TRUNCATED',
            params: { found: 40, proposed: 25 },
        });
    });

    it('reports lines the model could see but not read', async () => {
        readInvoiceMock.mockResolvedValue(okRead([draft()], 3));
        const res = await scanInvoice(ctx(), { file: aFile() });
        expect(res.warnings).toContainEqual({
            code: 'INVOICE_LINES_UNREADABLE',
            params: { count: 3 },
        });
    });

    it('refuses a foreign-currency line per LINE, not per invoice', async () => {
        readInvoiceMock.mockResolvedValue(
            okRead([draft(), draft({ currency: 'USD', amount: 40 })]),
        );
        const res = await scanInvoice(ctx(), { file: aFile() });
        expect(res.lines).toHaveLength(1);
        expect(res.warnings).toContainEqual({
            code: 'INVOICE_LINE_FOREIGN_CURRENCY',
            params: { count: 1 },
        });
    });

    it('carries NO server-authored sentence in a warning', async () => {
        readInvoiceMock.mockResolvedValue(okRead(Array.from({ length: 30 }, () => draft()), 2));
        const res = await scanInvoice(ctx(), { file: aFile() });
        expect(res.warnings.length).toBeGreaterThan(0);
        for (const w of res.warnings) {
            expect(Object.keys(w).sort()).toEqual(['code', 'params']);
            for (const v of Object.values(w.params ?? {})) {
                expect(typeof v).toBe('number');
            }
        }
    });
});

describe('what cannot be read', () => {
    it('answers 422 INVOICE_NOT_RECOGNISED, carrying the stored file id', async () => {
        readInvoiceMock.mockResolvedValue({
            read: null,
            usage: { model: 'm', promptTokens: 4, completionTokens: 0, totalTokens: 4 },
        });
        await expect(scanInvoice(ctx(), { file: aFile() })).rejects.toMatchObject({
            code: 'INVOICE_NOT_RECOGNISED',
            status: 422,
            // So a retry needs no re-upload.
            params: { invoiceFileId: 'file-1' },
        });
    });

    it('answers INVOICE_NOT_RECOGNISED when the model says it is not an invoice', async () => {
        readInvoiceMock.mockResolvedValue({
            read: { isInvoice: false, lines: [], unreadableLineCount: 0 },
            usage: { model: 'm', promptTokens: 4, completionTokens: 0, totalTokens: 4 },
        });
        await expect(scanInvoice(ctx(), { file: aFile() })).rejects.toMatchObject({
            code: 'INVOICE_NOT_RECOGNISED',
        });
    });

    it('distinguishes "read it, but no line is recordable" with its own code', async () => {
        readInvoiceMock.mockResolvedValue(okRead([draft({ currency: 'USD' })]));
        await expect(scanInvoice(ctx(), { file: aFile() })).rejects.toMatchObject({
            code: 'INVOICE_NO_USABLE_LINES',
            status: 422,
        });
    });
});

describe('the AI budget is both ASSERTED and RECORDED', () => {
    it('asserts the budget before the model is called', async () => {
        const order: string[] = [];
        assertAiBudgetMock.mockImplementation(() => {
            order.push('assert');
        });
        readInvoiceMock.mockImplementation(() => {
            order.push('read');
            return Promise.resolve(okRead([draft()]));
        });
        await scanInvoice(ctx(), { file: aFile() });
        expect(order).toEqual(['assert', 'read']);
    });

    it('records usage even when the read FAILED', async () => {
        readInvoiceMock.mockResolvedValue({
            read: null,
            usage: { model: 'claude-sonnet-4-6', promptTokens: 900, completionTokens: 0, totalTokens: 900 },
        });
        await expect(scanInvoice(ctx(), { file: aFile() })).rejects.toThrow();
        expect(recordAiUsageMock).toHaveBeenCalledTimes(1);
        expect(recordAiUsageMock.mock.calls[0][1]).toMatchObject({
            task: 'invoice-scan',
            totalTokens: 900,
        });
    });

    it('does not put the prompt or the supplier in the usage ledger', async () => {
        await scanInvoice(ctx(), { file: aFile() });
        const recorded = JSON.stringify(recordAiUsageMock.mock.calls[0][1]);
        expect(recorded).not.toContain('Петрол');
        expect(recorded).not.toContain('Дизел');
    });
});

describe('the fileId path', () => {
    it('reads an already-stored invoice without ingesting again', async () => {
        db.fileRecord.findFirst.mockResolvedValue({
            id: 'f-7',
            pathKey: 'invoices/y.pdf',
            mimeType: 'application/pdf',
            storageProvider: 'local',
        });
        const res = await scanInvoice(ctx(), { fileId: 'f-7' });
        expect(ingestMock).not.toHaveBeenCalled();
        expect(res.invoiceFileId).toBe('f-7');
    });

    it('refuses a file this tenant does not have', async () => {
        db.fileRecord.findFirst.mockResolvedValue(null);
        await expect(scanInvoice(ctx(), { fileId: 'f-nope' })).rejects.toMatchObject({
            code: 'COST_ENTRY_INVOICE_FILE_NOT_FOUND',
        });
    });
});

describe('the documentId path — what «Към разходи» actually sends', () => {
    /**
     * The phone holds a `documentId` and CANNOT hold a `fileId`:
     * `FarmDocument.fileRecordId` is not on the document DTO. Without this
     * resolution the «Документи» entry point could not be built, which is why
     * it is asserted rather than left to the route's shape.
     */
    it('resolves a document to its FileRecord and scans it', async () => {
        db.farmDocument.findFirst.mockResolvedValue({
            id: 'd-1',
            purgedAt: null,
            fileRecordId: 'fr-55',
        });
        db.fileRecord.findFirst.mockResolvedValue({
            id: 'fr-55',
            pathKey: 'cost-invoice/z.pdf',
            mimeType: 'application/pdf',
            storageProvider: 'local',
        });

        const res = await scanInvoice(ctx(), { documentId: 'd-1' });

        expect(ingestMock).not.toHaveBeenCalled();
        expect(res.invoiceFileId).toBe('fr-55');
        expect(res.lines[0].invoiceFileId).toBe('fr-55');
    });

    it('answers DOCUMENT_PURGED for a tombstone, not a missing-file code', async () => {
        // The row and its `fileRecordId` SURVIVE a purge on purpose, so
        // reading the id without checking `purgedAt` would chase bytes that
        // are gone and report the wrong cause.
        db.farmDocument.findFirst.mockResolvedValue({
            id: 'd-2',
            purgedAt: new Date('2026-10-01'),
            fileRecordId: 'fr-56',
        });
        await expect(scanInvoice(ctx(), { documentId: 'd-2' })).rejects.toMatchObject({
            code: 'DOCUMENT_PURGED',
        });
        expect(readInvoiceMock).not.toHaveBeenCalled();
    });

    it('answers DOCUMENT_NOT_FOUND when no row comes back', async () => {
        db.farmDocument.findFirst.mockResolvedValue(null);
        await expect(scanInvoice(ctx(), { documentId: 'd-nope' })).rejects.toMatchObject({
            code: 'DOCUMENT_NOT_FOUND',
        });
    });

    /**
     * The test above does NOT prove tenant isolation, and its name used to
     * claim it did.
     *
     * Measured: deleting `tenantId` from the `where` left all 25 tests green,
     * because a doubled `findFirst` returns whatever it was told to and cannot
     * express "this row belongs to another farm". With a mock, the only
     * observable is the QUERY, so the query is what this asserts — otherwise a
     * cross-tenant read would ship under a test named for it.
     */
    it('scopes the document lookup to the caller’s tenant', async () => {
        db.farmDocument.findFirst.mockResolvedValue(null);
        await expect(scanInvoice(ctx(), { documentId: 'd-1' })).rejects.toThrow();
        expect(db.farmDocument.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ id: 'd-1', tenantId: 't-1' }),
            }),
        );
    });

    it('scopes the FileRecord lookup to the caller’s tenant too', async () => {
        db.fileRecord.findFirst.mockResolvedValue(null);
        await expect(scanInvoice(ctx(), { fileId: 'fr-1' })).rejects.toThrow();
        expect(db.fileRecord.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ id: 'fr-1', tenantId: 't-1' }),
            }),
        );
    });

    it('spends nothing when the document cannot be used', async () => {
        db.farmDocument.findFirst.mockResolvedValue(null);
        await expect(scanInvoice(ctx(), { documentId: 'd-nope' })).rejects.toThrow();
        expect(assertAiBudgetMock).not.toHaveBeenCalled();
        expect(recordAiUsageMock).not.toHaveBeenCalled();
    });
});
