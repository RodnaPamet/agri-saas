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

    it('scopes the document to the handle from the path', async () => {
        mockGenerate.mockResolvedValue({ marker: 'doc' });
        await get();

        expect(mockGenerate.mock.calls[0][1]).toEqual({
            kind: 'treatment',
            treatmentGroupId: 'handle-1',
        });
    });
});
