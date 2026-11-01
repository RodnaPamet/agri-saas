/**
 * The per-activity «Дневник на стопанството» route, at the HTTP boundary
 * (#2696).
 *
 * `tests/integration/activity-campaign-diary.test.ts` proves what the document
 * CONTAINS against a real database. This proves the two things only the
 * handler owns: that the bytes are usable by a client, and that it asks the
 * gatherer for the ACTIVITY arm.
 *
 * That second one is the whole point of the file. The gatherer takes a
 * discriminated scope and the campaign arm is the older, more familiar one, so
 * a handler passing `kind: 'campaign'` with a handle where a label belongs
 * would throw `InvalidCampaignError` deep inside `campaignWindow` — a 500 from
 * a route whose input was perfectly valid.
 */
const mockGetTenantCtx = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...a: unknown[]) => mockGetTenantCtx(...a),
}));
jest.mock('@/app-layer/usecases/modules', () => ({
    assertModuleEnabled: jest.fn().mockResolvedValue(undefined),
}));

const mockGather = jest.fn();
jest.mock('@/app-layer/reports/campaign-diary/gather', () => ({
    gatherCampaignDiary: (...a: unknown[]) => mockGather(...a),
}));

const mockRender = jest.fn();
jest.mock('@/app-layer/reports/pdf/campaign-diary', () => ({
    renderCampaignDiary: (...a: unknown[]) => mockRender(...a),
}));

const mockCollect = jest.fn();
jest.mock('@/app-layer/reports/pdf/collect-buffer', () => ({
    collectPdfBuffer: (...a: unknown[]) => mockCollect(...a),
}));

const mockCreateDoc = jest.fn();
jest.mock('@/lib/pdf/pdfKitFactory', () => ({
    createPdfDocument: (...a: unknown[]) => mockCreateDoc(...a),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/t/[tenantSlug]/journal/activities/[treatmentGroupId]/campaign-diary/route';

const HANDLE = 'cultivate-handle-1';
const params = Promise.resolve({ tenantSlug: 'acme', treatmentGroupId: HANDLE });
const get = () =>
    GET(
        new NextRequest(
            `http://localhost/api/t/acme/journal/activities/${HANDLE}/campaign-diary`,
        ),
        { params },
    );

beforeEach(() => {
    jest.clearAllMocks();
    mockGetTenantCtx.mockResolvedValue({ tenantId: 't1', userId: 'u1', role: 'OWNER' });
    mockCollect.mockResolvedValue(Buffer.from('%PDF-1.7 fake'));
    mockCreateDoc.mockReturnValue({ marker: 'doc' });
    mockGather.mockResolvedValue({
        header: { producerName: 'Иван Иванов', settlement: null, municipality: null, oblast: null },
        campaignLabel: '2026-2027',
        rows: [{ activity: 'Обработка на почвата – 12,40 ха' }],
        skippedIncomplete: 0,
        rowsWithUnknownArea: 0,
    });
});

describe('GET …/journal/activities/{handle}/campaign-diary', () => {
    it('asks the gatherer for the ACTIVITY arm, with the handle', async () => {
        await get();
        expect(mockGather).toHaveBeenCalledWith(
            expect.anything(),
            { kind: 'activity', treatmentGroupId: HANDLE },
        );
    });

    it('answers bytes inline, typed as a PDF and named for the handle', async () => {
        const res = await get();
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('application/pdf');
        // The phone checks for `%PDF` and opens Quick Look; a JSON envelope
        // around a base64 body would need a client change on every platform.
        expect(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString()).toBe('%PDF');
        expect(res.headers.get('Content-Disposition')).toContain(
            `dnevnik-stopanstvo-${HANDLE}.pdf`,
        );
        expect(res.headers.get('Cache-Control')).toBe('no-store');
    });

    it('renders «ДНЕВНИК НА СТОПАНСТВОТО» in landscape, not Приложение 1', async () => {
        await get();
        const [meta, opts] = mockCreateDoc.mock.calls[0];
        // The title is the assertion that separates this document from the
        // plant-protection register. A cultivation has no row in Приложение 1,
        // and printing one under that form's name is the defect the route
        // name was chosen to avoid.
        expect((meta as { reportTitle: string }).reportTitle).toBe('ДНЕВНИК НА СТОПАНСТВОТО');
        expect(opts).toMatchObject({ layout: 'landscape' });
        // Nine columns of Cyrillic: the unicode font is not cosmetic, it is
        // whether the page has words on it.
        expect((meta as { fontFamily: string }).fontFamily).toBe('unicode');
    });

    it('names the FARM when a profile exists, falling back to the slug', async () => {
        await get();
        expect(mockCreateDoc.mock.calls[0][0]).toMatchObject({ tenantName: 'Иван Иванов' });

        jest.clearAllMocks();
        mockGetTenantCtx.mockResolvedValue({ tenantId: 't1', userId: 'u1', role: 'OWNER' });
        mockCollect.mockResolvedValue(Buffer.from('%PDF-1.7 fake'));
        mockCreateDoc.mockReturnValue({ marker: 'doc' });
        mockGather.mockResolvedValue({
            header: { producerName: null, settlement: null, municipality: null, oblast: null },
            campaignLabel: '2026-2027',
            rows: [{}],
            skippedIncomplete: 0,
            rowsWithUnknownArea: 0,
        });
        await get();
        expect(mockCreateDoc.mock.calls[0][0]).toMatchObject({ tenantName: 'acme' });
    });

    it("surfaces the gatherer's coded refusal as a 404 carrying the code", async () => {
        // `ACTIVITY_NOT_FOUND` vs `REGISTER_EMPTY_FOR_PERIOD` is the
        // distinction a client acts on — a wrong handle versus an unfinished
        // record — so what matters is that the handler adds nothing and takes
        // nothing away.
        //
        // It RESOLVES rather than rejects: `withApiErrorHandling` catches a
        // coded error and answers the Response. I asserted a rejection first
        // and the test told me otherwise, which is the same shape the sibling
        // suite already pins.
        const { codedNotFound } = await import('@/lib/errors/types');
        mockGather.mockRejectedValue(
            codedNotFound('ACTIVITY_NOT_FOUND', 'No activity was recorded under that handle.', {
                reference: 'treatmentGroupId',
            }),
        );
        const res = await get();
        expect(res.status).toBe(404);
        expect(await res.json()).toMatchObject({ error: { code: 'ACTIVITY_NOT_FOUND' } });
        // And nothing was rendered — a refusal must not have built a document.
        expect(mockRender).not.toHaveBeenCalled();
        expect(mockCollect).not.toHaveBeenCalled();
    });
});
