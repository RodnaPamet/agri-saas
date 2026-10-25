/**
 * The per-entry ДНЕВНИК route at the HTTP boundary (#1740 item 3).
 *
 * `tests/integration/farm-record-diary.test.ts` proves what the document
 * CONTAINS against a real database. This proves the two things only the
 * handler owns, both of which decide whether a client can use the response at
 * all.
 */
const mockGetTenantCtx = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...a: unknown[]) => mockGetTenantCtx(...a),
}));
jest.mock('@/app-layer/usecases/modules', () => ({
    assertModuleEnabled: jest.fn().mockResolvedValue(undefined),
}));

const mockGenerate = jest.fn();
jest.mock('@/app-layer/reports/pdf/farm-record-diary', () => ({
    generateFarmRecordDiaryPdfScoped: (...a: unknown[]) => mockGenerate(...a),
}));

const mockCollect = jest.fn();
jest.mock('@/app-layer/reports/pdf/collect-buffer', () => ({
    collectPdfBuffer: (...a: unknown[]) => mockCollect(...a),
}));

// The route reads the treatment's KIND to decide which refusal an empty
// document deserves (#2316). Mocked because this file asserts the mapping, not
// the lookup — `tests/integration/seed-in-the-diary.test.ts` proves the real
// query. Leaving it unmocked is what reddened CI: the handler reached real
// Prisma from a unit test and answered 500 where the suite expected 404.
const mockTreatmentKindOf = jest.fn();
jest.mock('@/app-layer/usecases/diary-treatment', () => ({
    treatmentKindOf: (...a: unknown[]) => mockTreatmentKindOf(...a),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/t/[tenantSlug]/journal/treatments/[treatmentGroupId]/farm-record/route';

const params = Promise.resolve({ tenantSlug: 'acme', treatmentGroupId: 'handle-1' });
const get = () =>
    GET(
        new NextRequest('http://localhost/api/t/acme/journal/treatments/handle-1/farm-record'),
        { params },
    );

beforeEach(() => {
    jest.clearAllMocks();
    mockGetTenantCtx.mockResolvedValue({ tenantId: 't1', userId: 'u1', role: 'OWNER' });
    mockCollect.mockResolvedValue(Buffer.from('%PDF-1.7 fake'));
    // The default is the emptiest world: the handle names nothing. Each test
    // that cares about a kind sets its own.
    mockTreatmentKindOf.mockResolvedValue(null);
});

describe('GET …/journal/treatments/{handle}/farm-record', () => {
    it('answers bytes inline, typed as a PDF and named', async () => {
        mockGenerate.mockResolvedValue({ marker: 'doc' });
        const res = await get();

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('application/pdf');
        // A client that cannot tell this is a document cannot open it, and
        // the phone checks for `%PDF` before handing it to Quick Look.
        expect(res.headers.get('Content-Disposition')).toMatch(/dnevnik-handle-1\.pdf/);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        const body = Buffer.from(await res.arrayBuffer());
        expect(body.subarray(0, 4).toString()).toBe('%PDF');
        // Length must match the bytes, or a client reading to Content-Length
        // truncates the document.
        expect(res.headers.get('Content-Length')).toBe(String(body.length));
    });

    it('404s a handle with no recorded lines, rather than an empty register', async () => {
        // THE case this handler exists to get right. A blank ДНЕВНИК is
        // indistinguishable from a real one whose treatment recorded nothing,
        // and a farmer holding it cannot tell which they have. The generator
        // returns null for exactly this, so the mapping lives here.
        mockGenerate.mockResolvedValue(null);

        const res = await get();
        expect(res.status).toBe(404);
        await expect(res.json()).resolves.toMatchObject({
            error: { code: 'TREATMENT_NOT_FOUND' },
        });
        // And no bytes were collected — a 404 must not have rendered.
        expect(mockCollect).not.toHaveBeenCalled();
    });

    it('refuses a SOWING with its own code, not TREATMENT_NOT_FOUND', async () => {
        // A sowing's record EXISTS and prints in «ДНЕВНИК НА СТОПАНСТВОТО»; it
        // is only the БАБХ register that excludes it. Answering
        // TREATMENT_NOT_FOUND would say the handle names nothing and send a
        // client looking for a write that did not fail.
        mockGenerate.mockResolvedValue(null);
        mockTreatmentKindOf.mockResolvedValue('SEED');

        const res = await get();
        expect(res.status).toBe(404);
        await expect(res.json()).resolves.toMatchObject({
            error: { code: 'NOT_IN_BABH_REGISTER' },
        });
        expect(mockCollect).not.toHaveBeenCalled();
    });

    it('a treatment that recorded nothing is NOT_FOUND, not excluded', async () => {
        // The control for the case above. A SPRAY with no completed line
        // produces no document either, and if the exclusion branch widened to
        // cover it the farmer would be told their spraying is out of the
        // register — a false statement about a regulated record.
        mockGenerate.mockResolvedValue(null);
        mockTreatmentKindOf.mockResolvedValue('SPRAY');

        const res = await get();
        expect(res.status).toBe(404);
        await expect(res.json()).resolves.toMatchObject({
            error: { code: 'TREATMENT_NOT_FOUND' },
        });
    });

    it('does not look the kind up when there IS a document', async () => {
        // The lookup is a second query, and it belongs on the error path only.
        // Pinned because moving it above the `!pdfDoc` branch would cost every
        // successful export an extra round trip with nothing failing.
        mockGenerate.mockResolvedValue({ marker: 'doc' });

        const res = await get();
        expect(res.status).toBe(200);
        expect(mockTreatmentKindOf).not.toHaveBeenCalled();
    });

    it('scopes the document to the handle from the path', async () => {
        mockGenerate.mockResolvedValue({ marker: 'doc' });
        await get();

        expect(mockGenerate.mock.calls[0][1]).toEqual({
            kind: 'treatment',
            treatmentGroupId: 'handle-1',
        });
    });
});
