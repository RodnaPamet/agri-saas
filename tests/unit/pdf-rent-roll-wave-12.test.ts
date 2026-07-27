/* eslint-disable @typescript-eslint/no-explicit-any -- the PDFKit document is a
 * large chainable surface; a structural fake is the practical shape here. */

/**
 * Zero-coverage PDF builders, wave 12: `rent-roll`.
 *
 * The odd one out among the PDF builders — a Bulgarian-language report that
 * hand-rolls its own ruled table instead of using `@/lib/pdf/table`, and
 * renders every string through the Unicode font rather than the default
 * Helvetica. Both of those are load-bearing:
 *
 *   1. **The font.** Cyrillic in Helvetica does not render as Cyrillic; it
 *      renders as garbage. Every `text()` call goes through UNICODE_FONT or
 *      UNICODE_FONT_BOLD and `meta.fontFamily` is 'unicode'. A single call
 *      that reverted to the default font would silently corrupt a column of
 *      owner names in a document that goes to landowners.
 *
 *   2. **Per-unit totals — money and produce are NEVER summed.** Bulgarian
 *      farm rent is paid in leva OR in produce (кг/дка), and the season
 *      totals arrive as one entry per unit. The builder joins them with
 *      ' · ' rather than adding them, because "1 200" of leva plus grain
 *      kilos is not a quantity that exists. The source comment says so
 *      outright: "money and produce are never summed", and again on the
 *      per-lessor rows: "no лв is asserted over a кг/дка obligation".
 *      A well-meaning `.reduce((a, b) => a + b.total, 0)` here would
 *      produce a confident, wrong number on a legal document.
 *
 * The third detail worth a test is `rentTotal != null` rather than a truthy
 * check: a rent of ZERO is a real, meaningful figure and must print as "0",
 * not collapse to an em-dash alongside genuinely absent data.
 */

const mockGetRentRoll = jest.fn();
jest.mock('@/app-layer/usecases/rent-roll', () => ({
    getRentRoll: (...a: unknown[]) => mockGetRentRoll(...a),
}));

const mockTenantFindFirst = jest.fn();
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) =>
        fn({ tenant: { findFirst: (...a: unknown[]) => mockTenantFindFirst(...a) } }),
    ),
}));

// Text calls are recorded with the font that was active when they ran, so a
// reversion to the default font is observable.
interface TextCall {
    str: string;
    font: string;
}
let textCalls: TextCall[] = [];
let doc: any;

function fakeDoc() {
    let currentFont = 'NOT-SET';
    const d: any = {
        x: 40,
        y: 100,
        page: { width: 595, height: 842, margins: { left: 40, right: 40, top: 50, bottom: 50 } },
        pages: 1,
        addPage: jest.fn(() => {
            d.pages += 1;
            return d;
        }),
        font: jest.fn((f: string) => {
            currentFont = f;
            return d;
        }),
        fontSize: jest.fn(() => d),
        fillColor: jest.fn(() => d),
        strokeColor: jest.fn(() => d),
        lineWidth: jest.fn(() => d),
        moveTo: jest.fn(() => d),
        lineTo: jest.fn(() => d),
        stroke: jest.fn(() => d),
        moveDown: jest.fn(() => d),
        text: jest.fn((str: string) => {
            textCalls.push({ str: String(str), font: currentFont });
            return d;
        }),
    };
    return d;
}

const mockCreatePdfDocument = jest.fn((_meta?: unknown) => doc);
jest.mock('@/lib/pdf/pdfKitFactory', () => ({
    createPdfDocument: (...a: unknown[]) => mockCreatePdfDocument(...(a as [])),
    UNICODE_FONT: 'NotoSans',
    UNICODE_FONT_BOLD: 'NotoSans-Bold',
}));

import { generateRentRollPdf } from '@/app-layer/reports/pdf/rent-roll';
import { REPORT_DAYS } from '@/lib/agro/lease-expiry';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN', {
    tenantSlug: 'acme',
    tenantId: 'tenant-1',
    userId: 'user-1',
});

const lessor = (over: Record<string, unknown> = {}) => ({
    lessorName: 'Иван Петров',
    lessorEik: '123456789',
    leaseCount: 2,
    leasedDca: 120.5,
    rentTotal: 340.25,
    rentUnit: 'BGN_PER_DCA',
    paid: 200,
    outstanding: 140.25,
    ...over,
});

const expiring = (over: Record<string, unknown> = {}) => ({
    parcelName: 'Северна нива',
    lessorName: 'Иван Петров',
    kind: 'ARENDA',
    endDate: '2026-09-30',
    daysLeft: 64,
    ...over,
});

const rentRoll = (over: Record<string, unknown> = {}) => ({
    totalLeasedDca: 240.75,
    lessorCount: 3,
    activeLeaseCount: 5,
    seasonYear: 2026,
    totals: [{ unit: 'BGN_PER_DCA', total: 340.25, outstanding: 140.25 }],
    byLessor: [lessor()],
    expiringSoon: [expiring()],
    ...over,
});

const allText = () => textCalls.map((t) => t.str).join('\n');

beforeEach(() => {
    jest.clearAllMocks();
    textCalls = [];
    doc = fakeDoc();
    mockTenantFindFirst.mockResolvedValue({ name: 'Ферма Акме' });
    mockGetRentRoll.mockResolvedValue(rentRoll());
});

describe('generateRentRollPdf — data access', () => {
    it('reads the rent roll through the tenant context with the 90-day window', async () => {
        await generateRentRollPdf(ctx);

        expect(mockGetRentRoll).toHaveBeenCalledWith(ctx, {
            expiringWithinDays: REPORT_DAYS,
            locationId: undefined,
        });
        expect(mockTenantFindFirst).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            select: { name: true },
        });
    });

    it('scopes to one location when asked', async () => {
        await generateRentRollPdf(ctx, { locationId: 'loc-9' });

        expect(mockGetRentRoll.mock.calls[0][1].locationId).toBe('loc-9');
    });

    it('falls back to a generic farm name', async () => {
        mockTenantFindFirst.mockResolvedValue(null);

        await generateRentRollPdf(ctx);

        expect((mockCreatePdfDocument.mock.calls[0][0] as any).tenantName).toBe('Farm');
    });
});

describe('generateRentRollPdf — Cyrillic rendering', () => {
    it('declares the unicode font family in the document meta', async () => {
        await generateRentRollPdf(ctx);

        expect(mockCreatePdfDocument.mock.calls[0][0]).toMatchObject({
            fontFamily: 'unicode',
            reportTitle: 'Ведомост за наеми и задължения',
            watermark: 'NONE',
        });
    });

    it('renders EVERY string through a unicode font, never the default', async () => {
        // The invariant: Cyrillic in Helvetica is not Cyrillic, it is
        // garbage. One reverted `font()` call would corrupt a whole column
        // of owner names in a document that goes to landowners.
        await generateRentRollPdf(ctx);

        expect(textCalls.length).toBeGreaterThan(5);
        const fonts = new Set(textCalls.map((t) => t.font));
        expect([...fonts].sort()).toEqual(['NotoSans', 'NotoSans-Bold']);
    });

    it('titles the report and stamps the generated date', async () => {
        await generateRentRollPdf(ctx);

        expect(textCalls[0].str).toBe('Ведомост за наеми и задължения');
        expect(textCalls[0].font).toBe('NotoSans-Bold');
        expect(textCalls[1].str).toMatch(/^Ферма Акме · \d{4}-\d{2}-\d{2}$/);
    });
});

describe('generateRentRollPdf — per-unit totals', () => {
    it('NEVER sums money with produce — it lists each unit separately', async () => {
        // The load-bearing domain rule. Bulgarian farm rent is paid in leva
        // OR in produce, so the totals arrive one entry per unit. A
        // well-meaning reduce() here would print a confident, wrong number
        // on a legal document.
        mockGetRentRoll.mockResolvedValue(
            rentRoll({
                totals: [
                    { unit: 'BGN_PER_DCA', total: 120, outstanding: 20 },
                    { unit: 'KG_PER_DCA', total: 340, outstanding: 40 },
                ],
            }),
        );

        await generateRentRollPdf(ctx);
        const text = allText();

        // Both figures appear…
        expect(text).toMatch(/120/);
        expect(text).toMatch(/340/);
        // …and their sum does NOT.
        expect(text).not.toMatch(/460/);
        expect(text).not.toMatch(/\b60\b/); // 20 + 40 outstanding
        // Joined, not added.
        expect(text).toMatch(/ · /);
    });

    it('shows an em-dash for both totals when there are none', async () => {
        mockGetRentRoll.mockResolvedValue(rentRoll({ totals: [] }));

        await generateRentRollPdf(ctx);

        const summary = textCalls.find((t) => t.str.includes('Наета площ'))!.str;
        expect(summary).toContain('Рента/сезон: —');
        expect(summary).toContain('—');
    });

    it('reports area, owner and contract counts plus the season year', async () => {
        await generateRentRollPdf(ctx);

        const summary = textCalls.find((t) => t.str.includes('Наета площ'))!.str;
        expect(summary).toContain('Собственици: 3');
        expect(summary).toContain('Договори: 5');
        expect(summary).toContain('(2026)');
    });
});

describe('generateRentRollPdf — the lessor table', () => {
    it('renders one row per lessor with its own unit label', async () => {
        // A row is one (lessor × unit) pair, so the unit column labels that
        // row's own figures — no лв is asserted over a кг/дка obligation.
        await generateRentRollPdf(ctx);
        const text = allText();

        expect(text).toContain('Иван Петров');
        expect(text).toContain('123456789');
        expect(text).toContain('BGN_PER_DCA');
        expect(text).toContain('Наеми по собственик');
    });

    it('prints a ZERO rent as 0, not as an em-dash', async () => {
        // `rentTotal != null`, not a truthy check. A zero obligation is a
        // real figure; collapsing it into the "unknown" symbol would tell
        // the landowner something different from what the contract says.
        mockGetRentRoll.mockResolvedValue({
            ...rentRoll(),
            byLessor: [lessor({ rentTotal: 0, paid: 0, outstanding: 0 })],
        });

        await generateRentRollPdf(ctx);

        const cells = textCalls.map((t) => t.str);
        expect(cells).toContain('0');
    });

    it('em-dashes a genuinely missing EIK, rent and unit', async () => {
        mockGetRentRoll.mockResolvedValue({
            ...rentRoll(),
            byLessor: [lessor({ lessorEik: null, rentTotal: null, rentUnit: null })],
        });

        await generateRentRollPdf(ctx);

        expect(textCalls.filter((t) => t.str === '—').length).toBeGreaterThanOrEqual(3);
    });

    it('shows an empty-state line instead of a headerless table', async () => {
        mockGetRentRoll.mockResolvedValue(rentRoll({ byLessor: [] }));

        await generateRentRollPdf(ctx);
        const text = allText();

        expect(text).toContain('Няма регистрирани наеми.');
        // Assert on a header unique to the LESSOR table — 'Собственик' is
        // also a column in the expiring-contracts table below, which still
        // renders.
        expect(text).not.toContain('ЕИК');
        expect(text).not.toContain('Рента/сезон\n');
    });
});

describe('generateRentRollPdf — the expiring-contracts table', () => {
    it('translates the lease kind rather than leaking the enum', async () => {
        mockGetRentRoll.mockResolvedValue(
            rentRoll({
                expiringSoon: [
                    expiring({ kind: 'ARENDA' }),
                    expiring({ parcelName: 'Южна нива', kind: 'NAEM' }),
                ],
            }),
        );

        await generateRentRollPdf(ctx);
        const cells = textCalls.map((t) => t.str);

        expect(cells).toContain('Аренда');
        expect(cells).toContain('Наем');
        expect(cells).not.toContain('ARENDA');
        expect(cells).not.toContain('NAEM');
    });

    it('lists the parcel, end date and days remaining', async () => {
        await generateRentRollPdf(ctx);
        const cells = textCalls.map((t) => t.str);

        expect(cells).toContain('Северна нива');
        expect(cells).toContain('2026-09-30');
        expect(cells).toContain('64');
    });

    it('shows an empty-state line when nothing is expiring', async () => {
        mockGetRentRoll.mockResolvedValue(rentRoll({ expiringSoon: [] }));

        await generateRentRollPdf(ctx);

        expect(allText()).toContain('Няма изтичащи договори в следващите 90 дни.');
    });
});

describe('generateRentRollPdf — table paging', () => {
    it('starts a new page rather than writing past the bottom margin', async () => {
        // The hand-rolled table does its own paging; without it a long
        // rent roll would draw rows off the bottom of the sheet.
        mockGetRentRoll.mockResolvedValue({
            ...rentRoll(),
            byLessor: Array.from({ length: 80 }, (_, i) =>
                lessor({ lessorName: `Собственик ${i}` }),
            ),
        });

        await generateRentRollPdf(ctx);

        expect(doc.addPage).toHaveBeenCalled();
        // Every row still rendered — paging must not drop any.
        expect(allText()).toContain('Собственик 79');
    });

    it('does not page for a table that fits', async () => {
        await generateRentRollPdf(ctx);
        expect(doc.addPage).not.toHaveBeenCalled();
    });
});

describe('generateRentRollPdf — stream ownership', () => {
    it('returns the document without ending it', async () => {
        // The route's collectPdfBuffer finalises; ending here truncates it.
        const returned = await generateRentRollPdf(ctx);

        expect(returned).toBe(doc);
        expect(doc.end).toBeUndefined();
    });
});
