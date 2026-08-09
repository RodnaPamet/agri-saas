/* eslint-disable @typescript-eslint/no-explicit-any -- the PDFKit document is a
 * large chainable surface; a structural fake is the practical shape here. */

/**
 * Zero-coverage PDF builder, wave 10: `processMap`.
 *
 * The `riskRegister` half of this suite went with the GRC risk stack —
 * its headline invariant (severity buckets follow the TENANT'S matrix
 * bands rather than a second hardcoded threshold set) had no subject
 * left once the matrix config was removed.
 *
 * Structure, not bytes. The builder fetches data and drives the shared
 * `@/lib/pdf/*` primitives; asserting on rendered PDF bytes would be
 * both fragile and blind to the parts that can actually be wrong. So
 * the primitives are recorded and the assertions target the decisions:
 * which data was fetched, what order the document was assembled in, and
 * how the canvas image is fitted.
 */

const calls: string[] = [];
const record = (name: string) => (...args: unknown[]) => {
    calls.push(name);
    return args as unknown;
};

const mockPrisma = { tenant: { findUnique: jest.fn() } };
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: mockPrisma }));



/** A chainable structural stand-in for the PDFKit document. */
function fakeDoc() {
    const doc: any = {
        y: 100,
        page: { width: 842, height: 595 },
        images: [] as unknown[],
        texts: [] as unknown[],
        addPage: jest.fn(() => {
            calls.push('addPage');
            return doc;
        }),
        fontSize: jest.fn(() => doc),
        fillColor: jest.fn(() => doc),
        font: jest.fn(() => doc),
        moveDown: jest.fn(() => doc),
        text: jest.fn((...a: unknown[]) => {
            doc.texts.push(a);
            return doc;
        }),
        image: jest.fn((...a: unknown[]) => {
            calls.push('image');
            doc.images.push(a);
            return doc;
        }),
    };
    return doc;
}

let doc: ReturnType<typeof fakeDoc>;
const mockCreatePdfDocument = jest.fn((_meta?: unknown) => {
    calls.push('createPdfDocument');
    return doc;
});
jest.mock('@/lib/pdf/pdfKitFactory', () => ({
    createPdfDocument: (...a: unknown[]) => mockCreatePdfDocument(...(a as [])),
    BRAND: { navy: '#0b2545' },
    MARGINS: { left: 40, right: 40, top: 50, bottom: 50 },
}));

const mockAddCoverPage = jest.fn(record('addCoverPage'));
const mockAddMetadataPage = jest.fn(record('addMetadataPage'));
const mockApplyHeadersAndFooters = jest.fn(record('applyHeadersAndFooters'));
jest.mock('@/lib/pdf/layout', () => ({
    addCoverPage: (...a: unknown[]) => mockAddCoverPage(...a),
    addMetadataPage: (...a: unknown[]) => mockAddMetadataPage(...a),
    applyHeadersAndFooters: (...a: unknown[]) => mockApplyHeadersAndFooters(...a),
}));

const mockRenderTable = jest.fn(record('renderTable'));
jest.mock('@/lib/pdf/table', () => ({
    renderTable: (...a: unknown[]) => mockRenderTable(...a),
    autoColumnWidths: (ratios: number[]) => ratios.map((r) => r * 50),
}));

const mockAddSectionTitle = jest.fn(record('addSectionTitle'));
const mockAddSummaryMetrics = jest.fn(record('addSummaryMetrics'));
jest.mock('@/lib/pdf/sections', () => ({
    addSectionTitle: (...a: unknown[]) => mockAddSectionTitle(...a),
    addSummaryMetrics: (...a: unknown[]) => mockAddSummaryMetrics(...a),
    addSpacer: (...a: unknown[]) => mockAddSectionTitle('spacer', ...a),
}));

import { generateProcessMapPdf } from '@/app-layer/reports/pdf/processMap';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN', {
    tenantSlug: 'acme',
    tenantId: 'tenant-1',
    userId: 'user-1',
});

beforeEach(() => {
    jest.clearAllMocks();
    calls.length = 0;
    doc = fakeDoc();
    mockPrisma.tenant.findUnique.mockResolvedValue({ name: 'Acme Farms' });
});



// ─── processMap ──────────────────────────────────────────────────────

describe('generateProcessMapPdf', () => {
    const input = { mapName: 'Grain intake', version: 7, pngBytes: Buffer.from('png') };
    const metaArg = () => mockCreatePdfDocument.mock.calls[0][0] as any;

    it('titles the report from the map and versions the subtitle', async () => {
        await generateProcessMapPdf(ctx, input);

        expect(metaArg()).toMatchObject({
            tenantName: 'Acme Farms',
            reportTitle: 'Grain intake',
            reportSubtitle: 'Process Map · v7',
        });
        expect(metaArg().generatedAt).toEqual(expect.any(String));
    });

    it('falls back to an em-dash tenant name when the lookup misses', async () => {
        mockPrisma.tenant.findUnique.mockResolvedValue(null);

        await generateProcessMapPdf(ctx, input);

        expect(metaArg().tenantName).toBe('—');
    });

    it('puts the canvas image on its own page after the cover', async () => {
        await generateProcessMapPdf(ctx, input);

        expect(calls.indexOf('addCoverPage')).toBeLessThan(calls.indexOf('addPage'));
        expect(calls.indexOf('addPage')).toBeLessThan(calls.indexOf('image'));
        expect(calls[calls.length - 1]).toBe('applyHeadersAndFooters');
    });

    it('fits the PNG to the content rect rather than stretching it', async () => {
        // `fit` preserves the aspect ratio; a width/height pair would
        // distort a canvas the user is meant to read.
        await generateProcessMapPdf(ctx, input);

        const [bytes, x, y, opts] = doc.images[0] as any[];
        expect(bytes).toBe(input.pngBytes);
        expect(x).toBe(40); // MARGINS.left
        expect(y).toBe(doc.y);
        expect(opts.align).toBe('center');
        // content width = page 842 - left 40 - right 40
        expect(opts.fit[0]).toBe(762);
        // available height = page 595 - bottom 50 - imageTop
        expect(opts.fit[1]).toBe(595 - 50 - doc.y);
        expect(opts.width).toBeUndefined();
    });

    it('scopes the tenant lookup to the request context', async () => {
        await generateProcessMapPdf(ctx, input);

        expect(mockPrisma.tenant.findUnique).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            select: { name: true },
        });
    });

    it('returns the live document for the caller to stream', async () => {
        expect(await generateProcessMapPdf(ctx, input)).toBe(doc);
    });
});
