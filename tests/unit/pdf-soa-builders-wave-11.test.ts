/* eslint-disable @typescript-eslint/no-explicit-any -- the PDFKit document is a
 * large chainable surface; a structural fake is the practical shape here. */

/**
 * Zero-coverage PDF builders, wave 11: the two SoA-driven reports.
 *
 *   gapAnalysis · auditReadiness
 *
 * Same approach as wave 10 (#425) — record the shared `@/lib/pdf/*`
 * primitives and assert the decisions, not the bytes. These two are near
 * siblings: both read `getSoA` + `runSoAChecks`, both hash their inputs for
 * auditability, and both render conditionally on what the checks found.
 *
 * The detail most worth a test here is the collation. Both sort requirement
 * codes with `localeCompare(…, undefined, { numeric: true })`. Drop the
 * `numeric` option — an easy thing to lose while tidying a comparator — and
 * `A.5.10` sorts BEFORE `A.5.9`, because plain string collation compares
 * "1" against "9". An auditor reading an out-of-order Statement of
 * Applicability has no way to tell whether the tool or the data is wrong,
 * and nothing else in the stack would catch it.
 *
 * The conditional sections are the other half: an errors table only when
 * there are errors, a warnings table only when there are warnings, and a
 * distinct "No Gaps Found" section only when there are neither. Those three
 * branches are how the report reads as either a clean bill of health or a
 * remediation list, and they are trivially breakable.
 */

const calls: string[] = [];
const record = (name: string) => (...args: unknown[]) => {
    calls.push(name);
    return args as unknown;
};

const mockPrisma = { tenant: { findUnique: jest.fn() } };
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: mockPrisma }));

const mockGetSoA = jest.fn();
jest.mock('@/app-layer/usecases/soa', () => ({ getSoA: (...a: unknown[]) => mockGetSoA(...a) }));

const mockRunSoAChecks = jest.fn();
jest.mock('@/app-layer/usecases/soa-checks', () => ({
    runSoAChecks: (...a: unknown[]) => mockRunSoAChecks(...a),
}));

function fakeDoc() {
    const doc: any = {
        y: 100,
        page: { width: 595, height: 842 },
        addPage: jest.fn(() => {
            calls.push('addPage');
            return doc;
        }),
        fontSize: jest.fn(() => doc),
        fillColor: jest.fn(() => doc),
        font: jest.fn(() => doc),
        moveDown: jest.fn(() => doc),
        text: jest.fn(() => doc),
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
    autoColumnWidths: (ratios: number[]) => ratios.map((r) => r * 40),
}));

const mockAddSectionTitle = jest.fn(record('addSectionTitle'));
const mockAddSummaryMetrics = jest.fn(record('addSummaryMetrics'));
const mockAddParagraph = jest.fn(record('addParagraph'));
jest.mock('@/lib/pdf/sections', () => ({
    addSectionTitle: (...a: unknown[]) => mockAddSectionTitle(...a),
    addSummaryMetrics: (...a: unknown[]) => mockAddSummaryMetrics(...a),
    addParagraph: (...a: unknown[]) => mockAddParagraph(...a),
    addSpacer: jest.fn(),
}));

import { generateGapAnalysisPdf } from '@/app-layer/reports/pdf/gapAnalysis';
import { generateAuditReadinessPdf } from '@/app-layer/reports/pdf/auditReadiness';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN', {
    tenantSlug: 'acme',
    tenantId: 'tenant-1',
    userId: 'user-1',
});

const issue = (over: Record<string, unknown> = {}) => ({
    severity: 'error',
    requirementCode: 'A.5.1',
    rule: 'MISSING_JUSTIFICATION',
    reason: 'No justification recorded',
    suggestedAction: 'Add a justification',
    ...over,
});

const entry = (over: Record<string, unknown> = {}) => ({
    requirementCode: 'A.5.1',
    requirementTitle: 'Policies for information security',
    applicable: true,
    implementationStatus: 'FULLY_IMPLEMENTED',
    mappedControls: [{ id: 'c1' }],
    justification: 'Applies to all staff',
    ...over,
});

const SUMMARY = {
    total: 93,
    applicable: 80,
    notApplicable: 10,
    unmapped: 3,
    implemented: 60,
    missingJustification: 2,
};

const checks = (over: Record<string, unknown> = {}) => ({
    pass: true,
    errorCount: 0,
    warningCount: 0,
    issues: [] as unknown[],
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    calls.length = 0;
    doc = fakeDoc();
    mockPrisma.tenant.findUnique.mockResolvedValue({ name: 'Acme Farms' });
    mockGetSoA.mockResolvedValue({
        framework: 'ISO27001',
        entries: [entry()],
        summary: SUMMARY,
    });
    mockRunSoAChecks.mockReturnValue(checks());
});

const metaArg = () => mockCreatePdfDocument.mock.calls[0][0] as any;
const titles = () => mockAddSectionTitle.mock.calls.map((c) => c[1] as string);
const metrics = () =>
    Object.fromEntries(
        (mockAddSummaryMetrics.mock.calls[0][1] as Array<{ label: string; value: unknown }>).map((m) => [
            m.label,
            m.value,
        ]),
    );

// ─── gapAnalysis ─────────────────────────────────────────────────────

describe('generateGapAnalysisPdf', () => {
    it('requests the full SoA — evidence, tasks and tests', async () => {
        // The gap detection is only as good as what it can see; dropping any
        // of these would make the report claim fewer gaps than exist.
        await generateGapAnalysisPdf(ctx);

        expect(mockGetSoA).toHaveBeenCalledWith(ctx, {
            includeEvidence: true,
            includeTasks: true,
            includeTests: true,
        });
        expect(mockRunSoAChecks).toHaveBeenCalledWith([entry()]);
    });

    it('summarises pass state, counts and the gap total', async () => {
        mockRunSoAChecks.mockReturnValue(
            checks({ pass: false, errorCount: 2, warningCount: 3, issues: [issue(), issue()] }),
        );

        await generateGapAnalysisPdf(ctx);

        expect(metrics()).toMatchObject({
            Overall: 'FAIL',
            Errors: 2,
            Warnings: 3,
            'Total Issues': 2,
        });
        expect(metaArg().reportSubtitle).toBe('ISO 27001:2022 — 2 gaps identified');
    });

    it('reports PASS when the checks pass', async () => {
        await generateGapAnalysisPdf(ctx);
        expect(metrics().Overall).toBe('PASS');
    });

    describe('conditional sections', () => {
        it('renders the No-Gaps section, and NO tables, on a clean report', async () => {
            await generateGapAnalysisPdf(ctx);

            expect(titles()).toContain('No Gaps Found');
            expect(titles().some((t) => t.startsWith('Errors ('))).toBe(false);
            expect(titles().some((t) => t.startsWith('Warnings ('))).toBe(false);
            expect(mockRenderTable).not.toHaveBeenCalled();
        });

        it('renders only the errors table when there are errors alone', async () => {
            mockRunSoAChecks.mockReturnValue(
                checks({ pass: false, errorCount: 1, issues: [issue()] }),
            );

            await generateGapAnalysisPdf(ctx);

            expect(titles()).toContain('Errors (1)');
            expect(titles().some((t) => t.startsWith('Warnings ('))).toBe(false);
            expect(titles()).not.toContain('No Gaps Found');
            expect(mockRenderTable).toHaveBeenCalledTimes(1);
        });

        it('renders only the warnings table when there are warnings alone', async () => {
            mockRunSoAChecks.mockReturnValue(
                checks({ warningCount: 1, issues: [issue({ severity: 'warning' })] }),
            );

            await generateGapAnalysisPdf(ctx);

            expect(titles()).toContain('Warnings (1)');
            expect(titles().some((t) => t.startsWith('Errors ('))).toBe(false);
            expect(mockRenderTable).toHaveBeenCalledTimes(1);
        });

        it('renders both tables, errors first, when there are both', async () => {
            mockRunSoAChecks.mockReturnValue(
                checks({
                    pass: false,
                    errorCount: 1,
                    warningCount: 1,
                    issues: [issue({ severity: 'warning' }), issue()],
                }),
            );

            await generateGapAnalysisPdf(ctx);

            expect(titles().indexOf('Errors (1)')).toBeLessThan(titles().indexOf('Warnings (1)'));
            expect(mockRenderTable).toHaveBeenCalledTimes(2);
        });
    });

    it('swaps the narrative paragraph on pass vs fail', async () => {
        await generateGapAnalysisPdf(ctx);
        expect(mockAddParagraph.mock.calls[0][1]).toMatch(/No critical gaps detected/);

        jest.clearAllMocks();
        doc = fakeDoc();
        mockPrisma.tenant.findUnique.mockResolvedValue({ name: 'Acme Farms' });
        mockGetSoA.mockResolvedValue({ framework: 'ISO27001', entries: [entry()], summary: SUMMARY });
        mockRunSoAChecks.mockReturnValue(checks({ pass: false, errorCount: 1, issues: [issue()] }));

        await generateGapAnalysisPdf(ctx);
        expect(mockAddParagraph.mock.calls[0][1]).toMatch(/Critical gaps detected/);
    });

    it('sorts requirement codes NUMERICALLY, so A.5.9 precedes A.5.10', async () => {
        // The collation detail. Without `{ numeric: true }` plain string
        // ordering puts A.5.10 first, because it compares "1" against "9" —
        // and an auditor reading an out-of-order register cannot tell
        // whether the tool or the data is wrong.
        mockRunSoAChecks.mockReturnValue(
            checks({
                pass: false,
                errorCount: 3,
                issues: [
                    issue({ requirementCode: 'A.5.10' }),
                    issue({ requirementCode: 'A.5.9' }),
                    issue({ requirementCode: 'A.5.2' }),
                ],
            }),
        );

        await generateGapAnalysisPdf(ctx);

        const rows = mockRenderTable.mock.calls[0][2] as Array<{ code: string }>;
        expect(rows.map((r) => r.code)).toEqual(['A.5.2', 'A.5.9', 'A.5.10']);
    });

    it('sorts the warnings table numerically too, not just the errors', async () => {
        // Two separate comparators, so the warnings one needs its own case —
        // a single warning never invokes it.
        mockRunSoAChecks.mockReturnValue(
            checks({
                warningCount: 3,
                issues: [
                    issue({ severity: 'warning', requirementCode: 'A.5.10' }),
                    issue({ severity: 'warning', requirementCode: 'A.5.9' }),
                    issue({ severity: 'warning', requirementCode: 'A.5.1' }),
                ],
            }),
        );

        await generateGapAnalysisPdf(ctx);

        const rows = mockRenderTable.mock.calls[0][2] as Array<{ code: string }>;
        expect(rows.map((r) => r.code)).toEqual(['A.5.1', 'A.5.9', 'A.5.10']);
    });

    it('humanises the rule name for the reader', async () => {
        mockRunSoAChecks.mockReturnValue(
            checks({ pass: false, errorCount: 1, issues: [issue({ rule: 'MISSING_JUSTIFICATION' })] }),
        );

        await generateGapAnalysisPdf(ctx);

        const rows = mockRenderTable.mock.calls[0][2] as Array<{ rule: string }>;
        expect(rows[0].rule).toBe('MISSING JUSTIFICATION');
    });

    it('hashes only the issue count and pass flag — stable across runs', async () => {
        await generateGapAnalysisPdf(ctx);
        const hashA = metaArg().contentHash;

        jest.clearAllMocks();
        doc = fakeDoc();
        mockPrisma.tenant.findUnique.mockResolvedValue({ name: 'Acme Farms' });
        // Different entry objects, same check outcome.
        mockGetSoA.mockResolvedValue({
            framework: 'ISO27001',
            entries: [entry({ requirementCode: 'A.8.1' })],
            summary: SUMMARY,
        });
        mockRunSoAChecks.mockReturnValue(checks());

        await generateGapAnalysisPdf(ctx);
        expect(metaArg().contentHash).toBe(hashA);
    });

    it('carries the framework, defaults the watermark and falls back on tenant name', async () => {
        mockPrisma.tenant.findUnique.mockResolvedValue(null);

        await generateGapAnalysisPdf(ctx);

        expect(metaArg()).toMatchObject({
            tenantName: 'Tenant',
            reportTitle: 'Gap Analysis Report',
            framework: 'ISO27001',
            watermark: 'NONE',
        });
    });

    it('honours a watermark override', async () => {
        await generateGapAnalysisPdf(ctx, { watermark: 'DRAFT' as any });
        expect(metaArg().watermark).toBe('DRAFT');
    });

    it('assembles cover → metadata → content, headers/footers LAST', async () => {
        await generateGapAnalysisPdf(ctx);

        expect(calls.indexOf('addCoverPage')).toBeLessThan(calls.indexOf('addMetadataPage'));
        expect(calls.indexOf('addMetadataPage')).toBeLessThan(calls.indexOf('addPage'));
        expect(calls[calls.length - 1]).toBe('applyHeadersAndFooters');
    });
});

// ─── auditReadiness ──────────────────────────────────────────────────

describe('generateAuditReadinessPdf', () => {
    const soaRows = () => mockRenderTable.mock.calls[0][2] as Array<Record<string, string>>;
    const soaTotals = () => mockRenderTable.mock.calls[0][4] as { values: Record<string, string> };

    it('forwards an explicit framework to the SoA read', async () => {
        await generateAuditReadinessPdf(ctx, { framework: 'SOC2' });

        expect(mockGetSoA).toHaveBeenCalledWith(ctx, {
            framework: 'SOC2',
            includeEvidence: true,
            includeTasks: true,
            includeTests: true,
        });
    });

    it('passes undefined framework through when none is given', async () => {
        await generateAuditReadinessPdf(ctx);
        expect(mockGetSoA.mock.calls[0][1].framework).toBeUndefined();
    });

    it('renders the six SoA summary metrics from the report summary', async () => {
        await generateAuditReadinessPdf(ctx);

        expect(metrics()).toEqual({
            'Total Controls': 93,
            Applicable: 80,
            'Not Applicable': 10,
            Unmapped: 3,
            Implemented: 60,
            'Missing Just.': 2,
        });
    });

    it('states audit-readiness affirmatively on pass', async () => {
        await generateAuditReadinessPdf(ctx);
        expect(mockAddParagraph.mock.calls[0][1]).toMatch(/audit-ready/);
        expect(mockAddParagraph.mock.calls[0][1]).not.toMatch(/NOT audit-ready/);
    });

    it('quantifies the shortfall on fail', async () => {
        mockRunSoAChecks.mockReturnValue(
            checks({ pass: false, errorCount: 4, warningCount: 7, issues: [issue()] }),
        );

        await generateAuditReadinessPdf(ctx);

        expect(mockAddParagraph.mock.calls[0][1]).toBe(
            '✗ SoA is NOT audit-ready. 4 error(s), 7 warning(s) found.',
        );
    });

    describe('the SoA table', () => {
        it('renders the applicable tri-state, not a boolean', async () => {
            // `applicable` is three-valued: mapped-and-applicable,
            // mapped-and-excluded, and never mapped. Collapsing the last one
            // to "No" would hide unmapped requirements as deliberate
            // exclusions — the single worst thing this report could do.
            mockGetSoA.mockResolvedValue({
                framework: 'ISO27001',
                entries: [
                    entry({ requirementCode: 'A.1', applicable: true }),
                    entry({ requirementCode: 'A.2', applicable: false }),
                    entry({ requirementCode: 'A.3', applicable: null }),
                    entry({ requirementCode: 'A.4', applicable: undefined }),
                ],
                summary: SUMMARY,
            });

            await generateAuditReadinessPdf(ctx);

            expect(soaRows().map((r) => r.applicable)).toEqual(['Yes', 'No', 'Unmapped', 'Unmapped']);
        });

        it('humanises the status and falls back to an em-dash', async () => {
            mockGetSoA.mockResolvedValue({
                framework: 'ISO27001',
                entries: [
                    entry({ requirementCode: 'A.1', implementationStatus: 'PARTIALLY_IMPLEMENTED' }),
                    entry({ requirementCode: 'A.2', implementationStatus: null }),
                ],
                summary: SUMMARY,
            });

            await generateAuditReadinessPdf(ctx);

            expect(soaRows().map((r) => r.status)).toEqual(['PARTIALLY IMPLEMENTED', '—']);
        });

        it('counts mapped controls and falls back on a missing justification', async () => {
            mockGetSoA.mockResolvedValue({
                framework: 'ISO27001',
                entries: [
                    entry({ requirementCode: 'A.1', mappedControls: [{}, {}, {}], justification: null }),
                ],
                summary: SUMMARY,
            });

            await generateAuditReadinessPdf(ctx);

            expect(soaRows()[0].controls).toBe('3');
            expect(soaRows()[0].justification).toBe('—');
        });

        it('sorts entries numerically by requirement code', async () => {
            mockGetSoA.mockResolvedValue({
                framework: 'ISO27001',
                entries: [
                    entry({ requirementCode: 'A.5.10' }),
                    entry({ requirementCode: 'A.5.9' }),
                    entry({ requirementCode: 'A.5.1' }),
                ],
                summary: SUMMARY,
            });

            await generateAuditReadinessPdf(ctx);

            expect(soaRows().map((r) => r.code)).toEqual(['A.5.1', 'A.5.9', 'A.5.10']);
        });

        it('does not mutate the fetched entries while sorting', async () => {
            const entries = [entry({ requirementCode: 'A.9' }), entry({ requirementCode: 'A.1' })];
            mockGetSoA.mockResolvedValue({ framework: 'ISO27001', entries, summary: SUMMARY });

            await generateAuditReadinessPdf(ctx);

            expect(entries.map((e) => e.requirementCode)).toEqual(['A.9', 'A.1']);
        });

        it('carries a totals row drawn from the summary', async () => {
            await generateAuditReadinessPdf(ctx);

            expect(soaTotals().values).toMatchObject({
                code: 'TOTAL',
                title: '93 requirements',
                applicable: '80 yes',
                status: '60 impl.',
            });
        });
    });

    describe('the issues table', () => {
        it('is omitted entirely when there are no issues', async () => {
            await generateAuditReadinessPdf(ctx);

            expect(titles()).not.toContain('Readiness Issues');
            expect(mockRenderTable).toHaveBeenCalledTimes(1); // SoA table only
        });

        it('puts errors before warnings, then orders by code', async () => {
            mockRunSoAChecks.mockReturnValue(
                checks({
                    pass: false,
                    errorCount: 2,
                    warningCount: 2,
                    issues: [
                        issue({ severity: 'warning', requirementCode: 'A.1' }),
                        issue({ severity: 'error', requirementCode: 'A.5.10' }),
                        issue({ severity: 'warning', requirementCode: 'A.2' }),
                        issue({ severity: 'error', requirementCode: 'A.5.9' }),
                    ],
                }),
            );

            await generateAuditReadinessPdf(ctx);

            const rows = mockRenderTable.mock.calls[1][2] as Array<{ severity: string; code: string }>;
            expect(rows.map((r) => `${r.severity}:${r.code}`)).toEqual([
                'ERROR:A.5.9',
                'ERROR:A.5.10',
                'WARNING:A.1',
                'WARNING:A.2',
            ]);
        });

        it('does not mutate the checks issue array', async () => {
            const issues = [
                issue({ severity: 'warning', requirementCode: 'A.9' }),
                issue({ severity: 'error', requirementCode: 'A.1' }),
            ];
            mockRunSoAChecks.mockReturnValue(
                checks({ pass: false, errorCount: 1, warningCount: 1, issues }),
            );

            await generateAuditReadinessPdf(ctx);

            expect(issues.map((i) => i.severity)).toEqual(['warning', 'error']);
        });
    });

    it('hashes entry count, summary and issue count for auditability', async () => {
        await generateAuditReadinessPdf(ctx);
        const hashA = metaArg().contentHash;

        jest.clearAllMocks();
        doc = fakeDoc();
        mockPrisma.tenant.findUnique.mockResolvedValue({ name: 'Acme Farms' });
        mockGetSoA.mockResolvedValue({
            framework: 'ISO27001',
            entries: [entry()],
            summary: { ...SUMMARY, implemented: 61 }, // one control newly implemented
        });
        mockRunSoAChecks.mockReturnValue(checks());

        await generateAuditReadinessPdf(ctx);

        // A change in the underlying posture must change the hash, or the
        // hash is decorative.
        expect(metaArg().contentHash).not.toBe(hashA);
    });

    it('falls back to a generic tenant name when the lookup misses', async () => {
        mockPrisma.tenant.findUnique.mockResolvedValue(null);

        await generateAuditReadinessPdf(ctx);

        expect(metaArg()).toMatchObject({
            tenantName: 'Tenant',
            reportTitle: 'Audit Readiness Report',
            reportSubtitle: 'Statement of Applicability — ISO 27001:2022',
            watermark: 'NONE',
        });
    });

    it('honours a watermark override', async () => {
        await generateAuditReadinessPdf(ctx, { watermark: 'CONFIDENTIAL' as any });
        expect(metaArg().watermark).toBe('CONFIDENTIAL');
    });

    it('returns the document without ending it — the route owns the stream', async () => {
        // doc.end() is deliberately NOT called here; the route attaches its
        // listeners first. Calling it early truncates the response.
        const returned = await generateAuditReadinessPdf(ctx);

        expect(returned).toBe(doc);
        expect((doc as any).end).toBeUndefined();
        expect(calls[calls.length - 1]).toBe('applyHeadersAndFooters');
    });
});
