/**
 * `uploadToDrive` — #2019.
 *
 * Pure unit tests with a fetch double, because what is worth checking is the
 * REQUEST shape and the failure distinctions, and neither needs Google.
 */
import { uploadToDrive } from '@/app-layer/integrations/providers/google/drive';

const BOUNDARY = 'test-boundary';
const file = {
    name: 'dnevnik-2024-2025.pdf',
    mimeType: 'application/pdf',
    bytes: new TextEncoder().encode('%PDF-1.7 fake'),
};

function fetchReturning(status: number, body: unknown, captured?: { req?: RequestInit }) {
    return (async (_url: string | URL | Request, init?: RequestInit) => {
        if (captured) captured.req = init;
        return {
            status,
            ok: status >= 200 && status < 300,
            json: async () => body,
            text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
        } as unknown as Response;
    }) as unknown as typeof fetch;
}

describe('uploadToDrive (#2019)', () => {
    it('returns the file id and link on success', async () => {
        const r = await uploadToDrive('tok', file, {
            fetchImpl: fetchReturning(200, { id: 'f1', webViewLink: 'https://drive/f1' }),
        });
        expect(r).toEqual({ fileId: 'f1', webViewLink: 'https://drive/f1' });
    });

    it('tolerates a response with no webViewLink', async () => {
        const r = await uploadToDrive('tok', file, {
            fetchImpl: fetchReturning(200, { id: 'f1' }),
        });
        expect(r).toEqual({ fileId: 'f1', webViewLink: null });
    });

    it('sends multipart/RELATED, not multipart/form-data', async () => {
        // The trap this asserts: Drive's `uploadType=multipart` requires
        // `multipart/related`, and `FormData` emits `multipart/form-data`. Drive
        // rejects the latter with a 400 that does not say which part is wrong.
        const cap: { req?: RequestInit } = {};
        await uploadToDrive('tok', file, {
            fetchImpl: fetchReturning(200, { id: 'f1' }, cap),
            boundary: BOUNDARY,
        });
        const ct = (cap.req?.headers as Record<string, string>)['Content-Type'];
        expect(ct).toBe(`multipart/related; boundary=${BOUNDARY}`);
        expect(ct).not.toContain('form-data');
        expect((cap.req?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    });

    it('puts the metadata and the bytes in one related body', async () => {
        const cap: { req?: RequestInit } = {};
        await uploadToDrive('tok', file, {
            fetchImpl: fetchReturning(200, { id: 'f1' }, cap),
            boundary: BOUNDARY,
        });
        const body = new TextDecoder().decode(cap.req?.body as Uint8Array);
        expect(body).toContain(`--${BOUNDARY}`);
        expect(body).toContain('"name":"dnevnik-2024-2025.pdf"');
        expect(body).toContain('"mimeType":"application/pdf"');
        // The bytes themselves, after the second part's headers.
        expect(body).toContain('%PDF-1.7 fake');
        expect(body.trimEnd().endsWith(`--${BOUNDARY}--`)).toBe(true);
    });

    it('401 means the grant is gone, not that the token expired', async () => {
        // `resolveGoogleConnectionToken` already refreshes an expired token, so
        // a 401 after that is a revoked refresh token — only reconnecting fixes
        // it, and the message says so.
        await expect(
            uploadToDrive('tok', file, { fetchImpl: fetchReturning(401, 'Unauthorized') }),
        ).rejects.toMatchObject({ code: 'GOOGLE_GRANT_REVOKED' });
    });

    it('403 about a scope is a MISSING GRANT', async () => {
        await expect(
            uploadToDrive('tok', file, {
                fetchImpl: fetchReturning(403, { error: { message: 'Insufficient Permission' } }),
            }),
        ).rejects.toMatchObject({ code: 'GOOGLE_DRIVE_NOT_GRANTED' });
    });

    it('403 about anything else is NOT a missing grant', async () => {
        // The distinction that matters. Drive also 403s a full Drive, and
        // telling a farmer to reconnect when their storage is full would be
        // wrong advice confidently given. Without this case the two collapse.
        await expect(
            uploadToDrive('tok', file, {
                fetchImpl: fetchReturning(403, {
                    error: { message: 'The user has exceeded their Drive storage quota.' },
                }),
            }),
        ).rejects.toMatchObject({ code: 'GOOGLE_DRIVE_REFUSED' });
    });

    it('a 200 with no file id is NOT a success', async () => {
        // Returning a null id would make the caller report an export that may
        // not exist — a success message for a file nobody can find.
        await expect(
            uploadToDrive('tok', file, { fetchImpl: fetchReturning(200, { webViewLink: 'x' }) }),
        ).rejects.toThrow(/no file id/i);
    });

    it('reports an unexpected status rather than reinterpreting it', async () => {
        await expect(
            uploadToDrive('tok', file, { fetchImpl: fetchReturning(500, 'boom') }),
        ).rejects.toThrow(/500/);
    });
});
