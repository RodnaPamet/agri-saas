/* eslint-disable @typescript-eslint/no-explicit-any -- the PDFKit document is a
 * large chainable surface; a structural fake is the practical shape here. */

/**
 * Zero-coverage PDF builders, wave 10: `riskRegister` + `processMap`.
 *
 * Structure, not bytes. These builders fetch data, compute summaries, and
 * then drive the shared `@/lib/pdf/*` primitives; asserting on rendered PDF
 * bytes would be both fragile and blind to the parts that can actually be
 * wrong. So the primitives are recorded and the assertions target the
 * decisions: which data was fetched, what the summary computed, what order
 * the document was assembled in, and what reaches the table.
 *
 * The headline invariant is in `riskRegister`, and its own comment names the
 * bug it exists to prevent: severity buckets come from the TENANT'S OWN
 * matrix bands (via the same `resolveBandForScore` the UI uses) rather than
 * a second hardcoded >=15 / 8-14 / <8 threshold set that "silently
 * disagreed with the configured matrix the moment a tenant customised it".
 * That is a class of bug no type checker can see and no byte comparison
 * would localise, so the real scoring function is used here — not a mock —
 * and the test drives a CUSTOM matrix to prove the buckets follow it.
 *
 * Second: row order is `score desc, then title` and the content hash is
 * derived only from counts + band names. Together those make an export
 * reproducible — the same register produces the same hash regardless of
 * fetch order or generation time, which is what makes the hash meaningful
 * in an audit pack.
 */

const calls: string[] = [];
const record = (name: string) => (...args: unknown[]) => {
    calls.push(name);
    return args as unknown;
};

const mockPrisma = { tenant: { findUnique: jest.fn() } };
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: mockPrisma }));

const mockGetReports = jest.fn();
jest.mock('@/app-layer/usecases/report', () => ({
    getReports: (...a: unknown[]) => mockGetReports(...a),
}));

const mockGetRiskMatrixConfig = jest.fn();
jest.mock('@/app-layer/usecases/risk-matrix-config', () => ({
    getRiskMatrixConfig: (...a: unknown[]) => mockGetRiskMatrixConfig(...a),
}));

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

import { generateRiskRegisterPdf } from '@/app-layer/reports/pdf/riskRegister';
import { generateProcessMapPdf } from '@/app-layer/reports/pdf/processMap';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN', {
    tenantSlug: 'acme',
    tenantId: 'tenant-1',
    userId: 'user-1',
});

// A DELIBERATELY non-default matrix. If the builder ever reverts to
// hardcoded >=15 / 8-14 / <8 thresholds, these bucket counts change.
const CUSTOM_MATRIX = {
    bands: [
        { name: 'Minor', minScore: 1, maxScore: 3 },
        { name: 'Moderate', minScore: 4, maxScore: 9 },
        { name: 'Severe', minScore: 10, maxScore: 25 },
    ],
};

const risk = (over: Record<string, unknown> = {}) => ({
    title: 'Grain spoilage',
    threat: 'Moisture',
    likelihood: 3,
    impact: 4,
    score: 12,
    treatment: 'Mitigated',
    owner: 'Maria',
    controls: 'C-1, C-2',
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    calls.length = 0;
    doc = fakeDoc();
    mockPrisma.tenant.findUnique.mockResolvedValue({ name: 'Acme Farms' });
    mockGetRiskMatrixConfig.mockResolvedValue(CUSTOM_MATRIX);
    mockGetReports.mockResolvedValue({ riskRegister: [risk()] });
});

// ─── riskRegister ────────────────────────────────────────────────────

describe('generateRiskRegisterPdf', () => {
    const metricsArg = () => mockAddSummaryMetrics.mock.calls[0][1] as Array<{ label: string; value: unknown }>;
    const tableRows = () => mockRenderTable.mock.calls[0][2] as Array<Record<string, string>>;
    const totalsArg = () => mockRenderTable.mock.calls[0][4] as { values: Record<string, string> };
    const metaArg = () => mockCreatePdfDocument.mock.calls[0][0] as any;

    it('buckets severity by the TENANT’S matrix bands, not hardcoded thresholds', async () => {
        // The regression this file's own comment documents. Scores 2 / 6 / 20
        // fall in Minor / Moderate / Severe under the custom matrix; under the
        // old hardcoded >=15 / 8-14 / <8 set they would bucket differently.
        mockGetReports.mockResolvedValue({
            riskRegister: [
                risk({ title: 'A', score: 2 }),
                risk({ title: 'B', score: 6 }),
                risk({ title: 'C', score: 20 }),
                risk({ title: 'D', score: 20 }),
            ],
        });

        await generateRiskRegisterPdf(ctx);

        const byLabel = Object.fromEntries(metricsArg().map((m) => [m.label, m.value]));
        expect(byLabel['Minor (1–3)']).toBe(1);
        expect(byLabel['Moderate (4–9)']).toBe(1);
        expect(byLabel['Severe (10–25)']).toBe(2);
        expect(mockGetRiskMatrixConfig).toHaveBeenCalledWith(ctx);
    });

    it('lists band buckets severity-DESCENDING even though bands are stored ascending', async () => {
        await generateRiskRegisterPdf(ctx);

        const labels = metricsArg().map((m) => m.label);
        expect(labels[0]).toBe('Total Risks');
        expect(labels.slice(1, 4)).toEqual(['Severe (10–25)', 'Moderate (4–9)', 'Minor (1–3)']);
        expect(labels[labels.length - 1]).toBe('Untreated');
    });

    it('counts untreated risks by exact treatment label', async () => {
        mockGetReports.mockResolvedValue({
            riskRegister: [
                risk({ title: 'A', treatment: 'Untreated' }),
                risk({ title: 'B', treatment: 'Untreated' }),
                risk({ title: 'C', treatment: 'Mitigated' }),
            ],
        });

        await generateRiskRegisterPdf(ctx);

        const byLabel = Object.fromEntries(metricsArg().map((m) => [m.label, m.value]));
        expect(byLabel['Total Risks']).toBe(3);
        expect(byLabel['Untreated']).toBe(2);
    });

    describe('reproducibility', () => {
        it('orders rows score-descending, then title, so two exports match', async () => {
            // Deterministic order is what makes the content hash meaningful:
            // the same register must render identically regardless of the
            // order rows came back from the DB.
            mockGetReports.mockResolvedValue({
                riskRegister: [
                    risk({ title: 'Zebra', score: 5 }),
                    risk({ title: 'Apple', score: 20 }),
                    risk({ title: 'Mango', score: 5 }),
                    risk({ title: 'Banana', score: 20 }),
                ],
            });

            await generateRiskRegisterPdf(ctx);

            expect(tableRows().map((r) => r.title)).toEqual(['Apple', 'Banana', 'Mango', 'Zebra']);
        });

        it('does not mutate the fetched array while sorting', async () => {
            const rows = [risk({ title: 'B', score: 1 }), risk({ title: 'A', score: 9 })];
            mockGetReports.mockResolvedValue({ riskRegister: rows });

            await generateRiskRegisterPdf(ctx);

            expect(rows.map((r) => r.title)).toEqual(['B', 'A']);
        });

        it('derives the content hash from counts only — stable across generation time', async () => {
            const first = await generateRiskRegisterPdf(ctx);
            const hashA = metaArg().contentHash;

            jest.clearAllMocks();
            calls.length = 0;
            doc = fakeDoc();
            mockPrisma.tenant.findUnique.mockResolvedValue({ name: 'Acme Farms' });
            mockGetRiskMatrixConfig.mockResolvedValue(CUSTOM_MATRIX);
            // Same data, different object identities and a later clock.
            mockGetReports.mockResolvedValue({ riskRegister: [risk()] });
            await generateRiskRegisterPdf(ctx);

            expect(metaArg().contentHash).toBe(hashA);
            expect(first).toBeDefined();
        });

        it('changes the content hash when the register changes', async () => {
            await generateRiskRegisterPdf(ctx);
            const hashA = metaArg().contentHash;

            jest.clearAllMocks();
            doc = fakeDoc();
            mockPrisma.tenant.findUnique.mockResolvedValue({ name: 'Acme Farms' });
            mockGetRiskMatrixConfig.mockResolvedValue(CUSTOM_MATRIX);
            mockGetReports.mockResolvedValue({ riskRegister: [risk(), risk({ title: 'Second' })] });
            await generateRiskRegisterPdf(ctx);

            expect(metaArg().contentHash).not.toBe(hashA);
        });
    });

    describe('totals row', () => {
        it('averages the score to one decimal place', async () => {
            mockGetReports.mockResolvedValue({
                riskRegister: [risk({ score: 10 }), risk({ title: 'B', score: 15 })],
            });

            await generateRiskRegisterPdf(ctx);

            expect(totalsArg().values.score).toBe('Avg: 12.5');
            expect(totalsArg().values.title).toBe('2 risks total');
        });

        it('reports 0 rather than NaN for an empty register', async () => {
            // The divide-by-zero guard. "Avg: NaN" in an audit export is
            // worse than a wrong number — it reads as a broken tool.
            mockGetReports.mockResolvedValue({ riskRegister: [] });

            await generateRiskRegisterPdf(ctx);

            expect(totalsArg().values.score).toBe('Avg: 0');
            expect(totalsArg().values.title).toBe('0 risks total');
            expect(tableRows()).toEqual([]);
        });
    });

    it('renders em-dashes for every missing optional field', async () => {
        mockGetReports.mockResolvedValue({
            riskRegister: [
                risk({ threat: null, treatment: null, owner: null, controls: null, score: 6 }) as any,
            ],
        });

        await generateRiskRegisterPdf(ctx);

        const row = tableRows()[0];
        expect(row.threat).toBe('—');
        expect(row.treatment).toBe('—');
        expect(row.owner).toBe('—');
        expect(row.controls).toBe('—');
        // …but the computed cells still render real values.
        expect(row.lxi).toBe('3×4');
        expect(row.score).toBe('6');
    });

    it('assembles the document in the documented order, headers/footers LAST', async () => {
        // applyHeadersAndFooters iterates the finished page set, so it can
        // only run after every page exists.
        await generateRiskRegisterPdf(ctx);

        expect(calls.indexOf('createPdfDocument')).toBe(0);
        expect(calls.indexOf('addCoverPage')).toBeLessThan(calls.indexOf('addMetadataPage'));
        expect(calls.indexOf('addMetadataPage')).toBeLessThan(calls.indexOf('addPage'));
        expect(calls.indexOf('renderTable')).toBeLessThan(calls.indexOf('applyHeadersAndFooters'));
        expect(calls[calls.length - 1]).toBe('applyHeadersAndFooters');
    });

    it('defaults the watermark to NONE and honours an override', async () => {
        await generateRiskRegisterPdf(ctx);
        expect(metaArg().watermark).toBe('NONE');

        jest.clearAllMocks();
        doc = fakeDoc();
        mockPrisma.tenant.findUnique.mockResolvedValue({ name: 'Acme Farms' });
        mockGetRiskMatrixConfig.mockResolvedValue(CUSTOM_MATRIX);
        mockGetReports.mockResolvedValue({ riskRegister: [risk()] });
        await generateRiskRegisterPdf(ctx, { watermark: 'DRAFT' as any });
        expect(metaArg().watermark).toBe('DRAFT');
    });

    it('falls back to a generic tenant name when the lookup misses', async () => {
        mockPrisma.tenant.findUnique.mockResolvedValue(null);

        await generateRiskRegisterPdf(ctx);

        expect(metaArg().tenantName).toBe('Tenant');
        // The lookup is scoped to the context tenant, and lives HERE rather
        // than at the route layer (the no-prisma-in-routes guardrail).
        expect(mockPrisma.tenant.findUnique).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            select: { name: true },
        });
    });

    it('declares its data sources on the metadata page', async () => {
        await generateRiskRegisterPdf(ctx);

        const sources = mockAddMetadataPage.mock.calls[0][2] as Array<{ source: string }>;
        expect(sources.map((s) => s.source)).toEqual(['Risk Register', 'Control Mappings']);
    });
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
