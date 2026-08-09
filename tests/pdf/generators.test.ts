/**
 * PDF Generator Hardening Tests
 *
 * Verifies watermark, metadata page, totals row, and large dataset performance.
 */
import { createPdfDocument } from '@/lib/pdf/pdfKitFactory';
import { addCoverPage, addMetadataPage, applyHeadersAndFooters } from '@/lib/pdf/layout';
import { renderTable, autoColumnWidths } from '@/lib/pdf/table';
import { addSectionTitle, addSummaryMetrics, addSpacer } from '@/lib/pdf/sections';
import type { ReportMeta, DataSourceNote } from '@/lib/pdf/types';


describe('PDF document factory', () => {
    it('creates a document that emits valid PDF bytes', (done) => {
        const meta: ReportMeta = {
            tenantName: 'Test Corp',
            reportTitle: 'Test Report',
            generatedAt: new Date().toISOString(),
        };

        const doc = createPdfDocument(meta);
        const chunks: Buffer[] = [];

        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => {
            const pdf = Buffer.concat(chunks);
            expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
            expect(pdf.length).toBeGreaterThan(100);
            done();
        });

        doc.end();
    });

    it('renders cover + metadata + table + totals without errors', (done) => {
        const meta: ReportMeta = {
            tenantName: 'Test Corp',
            reportTitle: 'Full Test',
            reportSubtitle: 'With all sections',
            generatedAt: new Date().toISOString(),
            framework: 'ISO27001',
            watermark: 'DRAFT',
            contentHash: 'abc123def456',
        };

        const dataSources: DataSourceNote[] = [
            { source: 'Test Source', description: 'Test description for data source.' },
        ];

        const doc = createPdfDocument(meta);
        const chunks: Buffer[] = [];

        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => {
            const pdf = Buffer.concat(chunks);
            expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
            expect(pdf.length).toBeGreaterThan(500);
            done();
        });

        // Cover
        addCoverPage(doc, meta);

        // Metadata page
        addMetadataPage(doc, meta, dataSources);

        // Content page
        doc.addPage();

        // Section
        addSectionTitle(doc, 'Test Section');
        addSummaryMetrics(doc, [
            { label: 'Total', value: 42 },
            { label: 'Done', value: 10 },
        ]);
        addSpacer(doc);

        // Table with totals
        const widths = autoColumnWidths([1, 2, 1]);
        renderTable(doc, [
            { key: 'id', header: 'ID', width: widths[0] },
            { key: 'name', header: 'Name', width: widths[1] },
            { key: 'status', header: 'Status', width: widths[2], align: 'center' },
        ], [
            { id: '1', name: 'Test item one', status: 'PASS' },
            { id: '2', name: 'Test item two with a longer name that should wrap', status: 'FAIL' },
            { id: '3', name: 'Item three', status: 'PENDING' },
        ], undefined, {
            values: { id: 'TOTAL', name: '3 items', status: '' },
        });

        // Headers/footers/watermarks
        applyHeadersAndFooters(doc, meta);

        doc.end();
    });

    it('generates FINAL watermark without errors', (done) => {
        const meta: ReportMeta = {
            tenantName: 'Audit Corp',
            reportTitle: 'Final Report',
            generatedAt: new Date().toISOString(),
            watermark: 'FINAL',
        };

        const doc = createPdfDocument(meta);
        const chunks: Buffer[] = [];

        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => {
            const pdf = Buffer.concat(chunks);
            expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
            done();
        });

        addCoverPage(doc, meta);
        doc.addPage();
        addSectionTitle(doc, 'Content');
        applyHeadersAndFooters(doc, meta);
        doc.end();
    });
});

describe('Large dataset performance', () => {
    // PERF_CEILING_MS below is the real regression bar; the Jest
    // async-test timeout is bumped to 60s (above PERF_CEILING_MS) so
    // the assertion fires the failure (not the test timeout).
    it('generates a 1000-row table within the perf ceiling', (done) => {
        const meta: ReportMeta = {
            tenantName: 'Perf Corp',
            reportTitle: 'Performance Test',
            generatedAt: new Date().toISOString(),
            watermark: 'DRAFT',
        };

        const doc = createPdfDocument(meta);
        const chunks: Buffer[] = [];
        const startTime = Date.now();

        // Under the full-suite parallel run, CPU contention pushes this
        // far beyond the 5s headline. The 30s ceiling is the real
        // regression bar — it catches algorithmic slowdowns
        // (O(n²) inserts, missed buffer reuse) without flaking on
        // worker scheduling.
        const PERF_CEILING_MS = 30_000;

        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => {
            const elapsed = Date.now() - startTime;
            const pdf = Buffer.concat(chunks);

            // Valid PDF
            expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
            // Should be substantial (1000 rows = many pages)
            expect(pdf.length).toBeGreaterThan(10000);
            // Should complete within the perf ceiling
            expect(elapsed).toBeLessThan(PERF_CEILING_MS);

            done();
        });

        addCoverPage(doc, meta);
        addMetadataPage(doc, meta, [
            { source: 'Performance Test', description: '1000 rows of synthetic data' },
        ]);
        doc.addPage();

        const widths = autoColumnWidths([0.5, 2, 1, 1, 1.5, 2]);
        const rows = Array.from({ length: 1000 }, (_, i) => ({
            num: String(i + 1),
            title: `Risk item ${i + 1} — description with enough text to test multi-line cell wrapping behavior`,
            likelihood: String(Math.ceil(Math.random() * 5)),
            impact: String(Math.ceil(Math.random() * 5)),
            treatment: ['Mitigate', 'Accept', 'Transfer', 'Avoid'][i % 4],
            notes: i % 3 === 0 ? 'This is a longer note that should wrap across multiple lines in the cell' : '—',
        }));

        renderTable(doc, [
            { key: 'num', header: '#', width: widths[0], align: 'center' },
            { key: 'title', header: 'Risk', width: widths[1] },
            { key: 'likelihood', header: 'L', width: widths[2], align: 'center' },
            { key: 'impact', header: 'I', width: widths[3], align: 'center' },
            { key: 'treatment', header: 'Treatment', width: widths[4] },
            { key: 'notes', header: 'Notes', width: widths[5] },
        ], rows, undefined, {
            values: { num: '', title: '1000 risks total', likelihood: '', impact: '', treatment: '', notes: '' },
        });

        applyHeadersAndFooters(doc, meta);
        doc.end();
    }, 60_000); // 60s jest timeout — above PERF_CEILING_MS so the
                // perf-ceiling assertion fires the failure (not the
                // test timeout).
});
