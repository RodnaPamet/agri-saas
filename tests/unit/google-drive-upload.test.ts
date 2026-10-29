/**
 * `uploadToDrive` — #2019.
 *
 * Pure unit tests with a fetch double, because what is worth checking is the
 * REQUEST shape and the failure distinctions, and neither needs Google.
 */
import { ensureDriveFolder, uploadToDrive } from '@/app-layer/integrations/providers/google/drive';

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

/**
 * A double for the calls that make TWO requests — look the folder up, then
 * create it. Each entry answers one call in order, and `urls` records what was
 * asked for, because "did it even try to look it up?" is half of what these
 * cases assert.
 */
function fetchSequence(
    steps: Array<{ status: number; body: unknown }>,
    seen?: { urls: string[]; inits: Array<RequestInit | undefined> },
) {
    let i = 0;
    return (async (url: string | URL | Request, init?: RequestInit) => {
        const step = steps[i++];
        if (!step) throw new Error(`unexpected call ${i} to ${String(url)}`);
        if (seen) {
            seen.urls.push(String(url));
            seen.inits.push(init);
        }
        return {
            status: step.status,
            ok: step.status >= 200 && step.status < 300,
            json: async () => step.body,
            text: async () =>
                typeof step.body === 'string' ? step.body : JSON.stringify(step.body),
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

    it('429 is a RATE LIMIT with its OWN code, not the storage sentence', async () => {
        // #2447. A 429 used to fall through to `externalServiceError`, which
        // is a 502 — and `DomainError` sets `expose = status < 500`, so the
        // message became the literal 'An error occurred', with no
        // `errors.EXTERNAL_SERVICE_ERROR` entry to replace it. The operator
        // got no remedy at all.
        //
        // And it is NOT `GOOGLE_DRIVE_REFUSED`, whose sentence tells them to
        // check their Drive storage. That is right for the 403 quota case and
        // wrong here — the same wrong-advice trap the 403 arm above guards
        // against, pointing the other way.
        await expect(
            uploadToDrive('tok', file, { fetchImpl: fetchReturning(429, 'Rate Limit Exceeded') }),
        ).rejects.toMatchObject({ code: 'GOOGLE_DRIVE_RATE_LIMITED' });
    });

    it('a 5xx stays an UPSTREAM error, deliberately not a refusal', async () => {
        // The control for the case above: "Drive is down" is not "Drive
        // refused", and a 502 propagates the first honestly. Collapsing them
        // would make an outage read as something the farmer could act on.
        await expect(
            uploadToDrive('tok', file, { fetchImpl: fetchReturning(503, 'boom') }),
        ).rejects.toMatchObject({ code: 'EXTERNAL_SERVICE_ERROR' });
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

describe('uploadToDrive puts the file in a folder (#2019)', () => {
    it('names the folder as a parent when one is given', async () => {
        const cap: { req?: RequestInit } = {};
        await uploadToDrive('tok', file, {
            fetchImpl: fetchReturning(200, { id: 'f1' }, cap),
            boundary: BOUNDARY,
            folderId: 'folder-1',
        });
        const body = new TextDecoder().decode(cap.req?.body as Uint8Array);
        expect(body).toContain('"parents":["folder-1"]');
    });

    it('omits parents entirely when there is no folder', async () => {
        // Not `"parents":null` and not `"parents":[]` — Drive reads either as a
        // request it cannot satisfy rather than as "put it in the root".
        const cap: { req?: RequestInit } = {};
        await uploadToDrive('tok', file, {
            fetchImpl: fetchReturning(200, { id: 'f1' }, cap),
            boundary: BOUNDARY,
        });
        const body = new TextDecoder().decode(cap.req?.body as Uint8Array);
        expect(body).not.toContain('parents');
    });
});

describe('ensureDriveFolder (#2019)', () => {
    it('creates one when nothing is stored', async () => {
        const seen = { urls: [] as string[], inits: [] as Array<RequestInit | undefined> };
        const r = await ensureDriveFolder('tok', null, {
            name: 'Агрент — Дневници',
            fetchImpl: fetchSequence([{ status: 200, body: { id: 'new-1' } }], seen),
        });
        expect(r).toEqual({ folderId: 'new-1', created: true });
        // One call, and it is the create — no pointless lookup of a null id.
        expect(seen.urls).toHaveLength(1);
        expect(seen.inits[0]?.method).toBe('POST');
        expect(String(seen.inits[0]?.body)).toContain('application/vnd.google-apps.folder');
    });

    it('reuses a stored folder that still exists', async () => {
        const r = await ensureDriveFolder('tok', 'kept-1', {
            name: 'x',
            fetchImpl: fetchSequence([{ status: 200, body: { id: 'kept-1', trashed: false } }]),
        });
        // `created: false` is what stops the caller writing to configJson on
        // every single export.
        expect(r).toEqual({ folderId: 'kept-1', created: false });
    });

    it('a 404 on the stored id is a NORMAL state, not a failure', async () => {
        // The farmer deleted the folder. `drive.file` gives us no way to know
        // until we ask, and tidying their own Drive is not an error — surfacing
        // it as one would tell them to reconnect a connection that is fine.
        const r = await ensureDriveFolder('tok', 'gone-1', {
            name: 'x',
            fetchImpl: fetchSequence([
                { status: 404, body: { error: { message: 'File not found: gone-1.' } } },
                { status: 200, body: { id: 'new-2' } },
            ]),
        });
        expect(r).toEqual({ folderId: 'new-2', created: true });
    });

    it('a folder in the BIN is replaced, not reused', async () => {
        // The silent one. A trashed folder answers 200 and is retrievable by
        // id, so a check that only caught 404 would upload the register into
        // the farmer's bin and report success — no error anywhere, and the
        // document simply never found.
        const r = await ensureDriveFolder('tok', 'binned-1', {
            name: 'x',
            fetchImpl: fetchSequence([
                { status: 200, body: { id: 'binned-1', trashed: true } },
                { status: 200, body: { id: 'new-3' } },
            ]),
        });
        expect(r).toEqual({ folderId: 'new-3', created: true });
    });

    it('a 200 with no id on the stored lookup is replaced too', async () => {
        const r = await ensureDriveFolder('tok', 'odd-1', {
            name: 'x',
            fetchImpl: fetchSequence([
                { status: 200, body: {} },
                { status: 200, body: { id: 'new-4' } },
            ]),
        });
        expect(r).toEqual({ folderId: 'new-4', created: true });
    });

    it('401 on the lookup is a revoked grant, not a missing folder', async () => {
        await expect(
            ensureDriveFolder('tok', 'any', {
                name: 'x',
                fetchImpl: fetchSequence([{ status: 401, body: 'Unauthorized' }]),
            }),
        ).rejects.toMatchObject({ code: 'GOOGLE_GRANT_REVOKED' });
    });

    it('403 about a scope on the lookup is a missing grant', async () => {
        // The shared mapping is the point: the folder calls and the upload
        // answer a 403 the same way because they go through one function.
        await expect(
            ensureDriveFolder('tok', 'any', {
                name: 'x',
                fetchImpl: fetchSequence([
                    { status: 403, body: { error: { message: 'Insufficient Permission' } } },
                ]),
            }),
        ).rejects.toMatchObject({ code: 'GOOGLE_DRIVE_NOT_GRANTED' });
    });

    it('403 about storage on the create is a refusal, not a missing grant', async () => {
        await expect(
            ensureDriveFolder('tok', null, {
                name: 'x',
                fetchImpl: fetchSequence([
                    {
                        status: 403,
                        body: { error: { message: 'The user has exceeded their Drive storage quota.' } },
                    },
                ]),
            }),
        ).rejects.toMatchObject({ code: 'GOOGLE_DRIVE_REFUSED' });
    });

    it('says WHICH call failed on an unexpected status', async () => {
        // `refuseDrive` takes a label so a 500 names the lookup or the create
        // rather than just "Drive". One error shape for every cause means a
        // log names nothing.
        await expect(
            ensureDriveFolder('tok', 'any', {
                name: 'x',
                fetchImpl: fetchSequence([{ status: 500, body: 'boom' }]),
            }),
        ).rejects.toThrow(/folder lookup failed with 500/);
        await expect(
            ensureDriveFolder('tok', null, {
                name: 'x',
                fetchImpl: fetchSequence([{ status: 503, body: 'boom' }]),
            }),
        ).rejects.toThrow(/folder create failed with 503/);
    });

    it('a created folder with no id is NOT a success', async () => {
        // Proceeding with a null parent would put the export in the Drive root
        // silently, which is the thing the folder exists to prevent.
        await expect(
            ensureDriveFolder('tok', null, {
                name: 'x',
                fetchImpl: fetchSequence([{ status: 200, body: { name: 'x' } }]),
            }),
        ).rejects.toThrow(/no id/i);
    });
});
