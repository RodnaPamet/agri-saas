/**
 * GET /api/t/[tenantSlug]/farm-brand/share-card — P6.7 (#1816).
 *
 * Mocks the two things that need a database (`getTenantCtx`, the usecase) and
 * NOTHING else. The real generator runs, the real `contentDisposition` builds
 * the header, and the real `collectPdfBuffer` drains the document — so this
 * covers the whole byte path including the ordering trap that collector exists
 * for (listeners before `end()`, or the buffer comes back truncated rather
 * than failing).
 *
 * The flag is mocked as a FUNCTION rather than stubbed open, so the closed
 * gate is exercised behaviourally here and not only structurally by
 * `social-routes-flag-gated`.
 */
import { NextRequest } from 'next/server';

const getTenantCtxMock = jest.fn();
const buildCardMock = jest.fn();
const assertFlagMock = jest.fn();

jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getTenantCtx: (...a: unknown[]) => getTenantCtxMock(...a),
}));

jest.mock('@/app-layer/usecases/public-farm-profile', () => ({
    __esModule: true,
    buildFarmShareCard: (...a: unknown[]) => buildCardMock(...a),
}));

jest.mock('@/lib/feature-flags', () => ({
    __esModule: true,
    assertFeatureEnabled: (...a: unknown[]) => assertFlagMock(...a),
}));

import { GET } from '@/app/api/t/[tenantSlug]/farm-brand/share-card/route';
import { codedNotFound, codedBadRequest } from '@/lib/errors/types';

const CYRILLIC_NAME = 'Зеленчукова градина „Победа“';

/**
 * `NextRequest`, not `Request`. `withApiErrorHandling` reads
 * `req.nextUrl.pathname`, so a plain `Request` fails inside the wrapper for a
 * reason unrelated to anything under test.
 */
const request = () =>
    new NextRequest('http://localhost/api/t/pobeda/farm-brand/share-card', { method: 'GET' });

const call = () => GET(request(), { params: Promise.resolve({ tenantSlug: 'pobeda' }) });

describe('GET /farm-brand/share-card', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getTenantCtxMock.mockResolvedValue({ tenantId: 't-1', userId: 'u-1', requestId: 'r-1' });
        assertFlagMock.mockResolvedValue(undefined);
        buildCardMock.mockResolvedValue({
            handle: 'pobeda',
            displayName: CYRILLIC_NAME,
            tagline: 'Домати от Пловдивско',
            url: 'https://app.agrent.bg/f/pobeda',
            generatedAt: '2026-10-15T08:00:00.000Z',
        });
    });

    it('serves a real PDF', async () => {
        const res = await call();
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('application/pdf');

        const bytes = Buffer.from(await res.arrayBuffer());
        // The magic number, and a plausible length. A truncated buffer — the
        // failure mode of attaching listeners after `end()` — still starts
        // with `%PDF`, so the length is the half that catches it.
        expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
        expect(bytes.length).toBeGreaterThan(10_000);
        expect(res.headers.get('Content-Length')).toBe(String(bytes.length));
    });

    it('carries the farm’s Bulgarian name in the download header', async () => {
        const cd = (await call()).headers.get('Content-Disposition') ?? '';
        // Both halves of RFC 6266. The extended form carries the truth; the
        // quoted ASCII fallback is a transliteration, and a Cyrillic name in
        // a bare `filename=` does not degrade, it THROWS — a header value is
        // a ByteString.
        expect(cd).toContain('attachment;');
        expect(cd).toContain("filename*=UTF-8''");
        expect(decodeURIComponent(cd.split("filename*=UTF-8''")[1])).toBe(`${CYRILLIC_NAME}.pdf`);
        expect(cd).toMatch(/filename="[ -~]+"/);
    });

    it('is never cached', async () => {
        // The card embeds the farm's CURRENT public name. A cached copy hands
        // out a sheet naming what the farm used to be called.
        expect((await call()).headers.get('Cache-Control')).toBe('no-store, max-age=0');
    });

    it('gates on the public-profile flag before reading anything', async () => {
        assertFlagMock.mockRejectedValue(
            codedNotFound('FEATURE_NOT_FOUND', 'Not found'),
        );
        const res = await call();
        // 404, not 403: a dark-launched surface must stay undiscoverable.
        expect(res.status).toBe(404);
        expect(assertFlagMock).toHaveBeenCalledWith('social.public-profile', 'u-1');
        // And the gate comes FIRST. A route that built the card and then
        // checked would have already read the farm's public name.
        expect(buildCardMock).not.toHaveBeenCalled();
    });

    it('passes the usecase’s refusal through with its code intact', async () => {
        buildCardMock.mockRejectedValue(
            codedBadRequest(
                'FARM_BRAND_NOT_PUBLISHED',
                'Publish the farm profile first — a printed address that is not published leads nowhere.',
            ),
        );
        const res = await call();
        expect(res.status).toBe(400);
        // The envelope is NESTED (`ErrorResponse`), and the code is what a
        // client switches on — asserting only the status would pass for a
        // refusal whose cause got lost.
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code).toBe('FARM_BRAND_NOT_PUBLISHED');
    });
});
