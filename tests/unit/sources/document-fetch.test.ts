/**
 * `measureDocument` — the #3146 fetch-and-measure seam.
 *
 * Every case drives a FAKE `fetchPublicUrl` through the injection seam, so
 * nothing here touches the network or DNS. The seam defaults to the real
 * helper on purpose: a test that forgot to inject would make a real request
 * and fail loudly rather than pass against a stub that happens to exist.
 *
 * The property worth protecting is that **bytes are measured, never
 * inferred** — #3147 one layer out. So the suite carries a server that
 * under-declares its `Content-Length`, one that omits it entirely, and one
 * that over-declares it, because those three are the ways a header can lie
 * and only the first two are caught after the body is read.
 */
import { createHash } from 'node:crypto';

import { BlockedRequestError } from '@/lib/security/safe-fetch';
import {
    MAX_DOCUMENT_BYTES,
    measureDocument,
    type DocumentFetchResult,
} from '@/lib/sources/document-fetch';

const BODY = Buffer.from('%PDF-1.4 a small bulletin');
const BODY_SHA = createHash('sha256').update(BODY).digest('hex');

/** A Response double. `headers` is a real `Headers` so lookups are case-insensitive. */
function reply(
    body: Buffer,
    init: { status?: number; headers?: Record<string, string> } = {},
): Response {
    const status = init.status ?? 200;
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(init.headers ?? {}),
        arrayBuffer: async () =>
            body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    } as unknown as Response;
}

function fetcher(res: Response | (() => Promise<Response>)) {
    return jest.fn(async () => (typeof res === 'function' ? res() : res));
}

async function measure(
    f: ReturnType<typeof fetcher>,
    url = 'https://www.mzh.government.bg/x.pdf',
): Promise<DocumentFetchResult> {
    return measureDocument(url, { fetchImpl: f as never });
}

describe('measureDocument', () => {
    it('hashes the body and reports the MEASURED length', async () => {
        const f = fetcher(
            reply(BODY, { headers: { 'content-length': String(BODY.byteLength), 'content-type': 'application/pdf' } }),
        );
        const r = await measure(f);

        // Assert the mock was CALLED — "the mock did not apply" is otherwise
        // silent, and a real fetch would have been attempted.
        expect(f).toHaveBeenCalledTimes(1);
        expect(f.mock.calls[0]![0]).toBe('https://www.mzh.government.bg/x.pdf');
        expect(r).toEqual({
            ok: true,
            sha256: BODY_SHA,
            bytes: BODY.byteLength,
            contentType: 'application/pdf',
        });
    });

    it('measures bytes when the server sends NO Content-Length', async () => {
        // The #3147 shape: a missing header is not a missing document. Next
        // 16.4.5 strips this header from every route-handler response, and a
        // government CMS may omit it too — so an implementation that read the
        // header would record `bytes: 0` for a perfectly good PDF and then
        // report a change on the next run when the header came back.
        const r = await measure(fetcher(reply(BODY)));
        expect(r).toMatchObject({ ok: true, bytes: BODY.byteLength, sha256: BODY_SHA });
    });

    it('CONTROL — a Content-Length that UNDER-declares does not shrink the measurement', async () => {
        const r = await measure(
            fetcher(reply(BODY, { headers: { 'content-length': '3' } })),
        );
        expect(r).toMatchObject({ ok: true, bytes: BODY.byteLength });
    });

    it('refuses on the HEADER before buffering an absurd body', async () => {
        const huge = reply(BODY, {
            headers: { 'content-length': String(MAX_DOCUMENT_BYTES + 1) },
        });
        // `arrayBuffer` must not be reached: the point of the header check is
        // that the body is never buffered.
        const spy = jest.spyOn(huge, 'arrayBuffer');
        const r = await measure(fetcher(huge));
        expect(r).toMatchObject({ ok: false, failure: 'too-large' });
        expect(spy).not.toHaveBeenCalled();
    });

    it('refuses on the MEASUREMENT when the header lied about being small', async () => {
        // A server that under-declares defeats the header check entirely, so
        // this is the only cap that actually binds.
        const r = await measureDocument('https://www.mzh.government.bg/x.pdf', {
            fetchImpl: fetcher(reply(BODY, { headers: { 'content-length': '1' } })) as never,
            maxBytes: 4,
        });
        expect(r).toMatchObject({ ok: false, failure: 'too-large' });
        expect((r as { detail: string }).detail).toContain('measured');
    });

    it('a 2xx with ZERO bytes is `empty`, not a document', async () => {
        const r = await measure(fetcher(reply(Buffer.alloc(0))));
        expect(r).toMatchObject({ ok: false, failure: 'empty' });
    });

    it('a non-2xx is `unreachable` and carries the status', async () => {
        const r = await measure(fetcher(reply(BODY, { status: 404 })));
        expect(r).toMatchObject({ ok: false, failure: 'unreachable' });
        expect((r as { detail: string }).detail).toContain('404');
    });

    it('a host-policy refusal is `refused`, NOT `unreachable`', async () => {
        // The two mean opposite things: one is a decision of ours, the other
        // is the publisher not answering. Collapsing them would send somebody
        // to check МЗХ's uptime over our own policy.
        const f = jest.fn(async () => {
            throw new BlockedRequestError('private address');
        });
        const r = await measure(f as never);
        expect(r).toMatchObject({ ok: false, failure: 'refused' });
    });

    it('a thrown fetch is `unreachable` and never propagates', async () => {
        // One unreachable government page must not end the run for the other
        // twelve, so every failure is a VALUE.
        const f = jest.fn(async () => {
            throw new Error('ETIMEDOUT');
        });
        await expect(measure(f as never)).resolves.toMatchObject({
            ok: false,
            failure: 'unreachable',
        });
    });

    it('a body that fails mid-stream is `unreachable`, not `empty`', async () => {
        const res = reply(BODY);
        jest.spyOn(res, 'arrayBuffer').mockRejectedValue(new Error('aborted'));
        const r = await measure(fetcher(res));
        expect(r).toMatchObject({ ok: false, failure: 'unreachable' });
    });

    it('a null Content-Type is carried as null, not as a string', async () => {
        const r = await measure(fetcher(reply(BODY)));
        expect((r as { contentType: unknown }).contentType).toBeNull();
    });
});
