/**
 * POST /api/t/[tenantSlug]/locations/[id]/farm-record (PR2).
 * Mocks getTenantCtx + the generator; asserts the stream path returns
 * 200 + application/pdf with a Content-Disposition attachment.
 */
import { NextRequest } from 'next/server';
import { EventEmitter } from 'events';

const getTenantCtxMock = jest.fn();
const generateMock = jest.fn();

jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getTenantCtx: (...a: unknown[]) => getTenantCtxMock(...a),
}));

jest.mock('@/app-layer/reports/pdf/farm-record-diary', () => ({
    __esModule: true,
    generateFarmRecordDiaryPdf: (...a: unknown[]) => generateMock(...a),
}));

import { POST } from '@/app/api/t/[tenantSlug]/locations/[id]/farm-record/route';

/** Minimal PDFKit-doc stand-in: on end() it emits one chunk then 'end'. */
function fakeDoc(): PDFKit.PDFDocument {
    const d = new EventEmitter() as unknown as PDFKit.PDFDocument & EventEmitter;
    (d as unknown as { end: () => void }).end = () => {
        d.emit('data', Buffer.from('%PDF-1.4 fake dnevnik'));
        d.emit('end');
    };
    return d;
}

function makeRequest(body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/t/acme/locations/loc-1/farm-record', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('POST /locations/:id/farm-record', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getTenantCtxMock.mockResolvedValue({ tenantId: 'tenant-1', userId: 'user-1', requestId: 'req' });
        generateMock.mockResolvedValue(fakeDoc());
    });

    test('streams application/pdf on the happy path', async () => {
        const res = await POST(makeRequest({ from: '2026-01-01', to: '2026-12-31' }), {
            params: Promise.resolve({ tenantSlug: 'acme', id: 'loc-1' }),
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('application/pdf');
        expect(res.headers.get('Content-Disposition')).toContain('dnevnik-loc-1.pdf');
        expect(generateMock).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ locationId: 'loc-1', from: '2026-01-01', to: '2026-12-31' }),
        );
    });

    test('rejects a body missing from/to (400)', async () => {
        const res = await POST(makeRequest({ from: '2026-01-01' }), {
            params: Promise.resolve({ tenantSlug: 'acme', id: 'loc-1' }),
        });
        expect(res.status).toBe(400);
    });

    describe('an unparseable period is a 400, not a 500 (#1575)', () => {
        // `from`/`to` were a bare `z.string().min(1)`, and
        // `farm-record-diary.ts:871-872` converts them unchecked into two
        // Prisma date filters (`:910`, `:1036`). Verified behaviourally
        // against the real client: an Invalid Date in a `gte` filter throws
        // `PrismaClientValidationError`. So a malformed period was a 500 on a
        // regulatory-document endpoint, and `grep -c isNaN` over the whole
        // generator returns 0.
        test.each(['abcd', 'not-a-date', '2026-13-45', 'next tuesday'])(
            'from=%p',
            async (bad) => {
                const res = await POST(makeRequest({ from: bad, to: '2026-12-31' }), {
                    params: Promise.resolve({ tenantSlug: 'acme', id: 'loc-1' }),
                });
                expect(res.status).toBe(400);
            },
        );

        test.each(['abcd', '2026-13-45'])('to=%p', async (bad) => {
            const res = await POST(makeRequest({ from: '2026-01-01', to: bad }), {
                params: Promise.resolve({ tenantSlug: 'acme', id: 'loc-1' }),
            });
            expect(res.status).toBe(400);
        });

        test('the generator is never reached — the 400 is at the boundary', async () => {
            // Without this, a 400 produced somewhere downstream would look
            // identical. The point of validating at the route is that nothing
            // past it runs.
            await POST(makeRequest({ from: 'abcd', to: 'abcd' }), {
                params: Promise.resolve({ tenantSlug: 'acme', id: 'loc-1' }),
            });
            expect(generateMock).not.toHaveBeenCalled();
        });

        test('a DAY and an INSTANT both still work — the period is day-typed', async () => {
            // agrent-ios sends these as `BgDate.isoDay`, so the day form is
            // the primary shape and `instantTimestamp()` would be wrong here.
            for (const value of ['2026-01-01', '2026-01-01T00:00:00.000Z']) {
                const res = await POST(makeRequest({ from: value, to: '2026-12-31' }), {
                    params: Promise.resolve({ tenantSlug: 'acme', id: 'loc-1' }),
                });
                expect(res.status).toBe(200);
            }
        });
    });
});
