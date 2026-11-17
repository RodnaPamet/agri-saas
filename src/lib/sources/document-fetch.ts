/**
 * Fetch an external document and MEASURE it, for the #3146 citation watch.
 *
 * ## Why this is not a fourth fetch helper
 *
 * It delegates to `fetchPublicUrl` from `@/lib/security/safe-fetch` rather
 * than calling `fetch`. That matters here more than it does for
 * `mzh-client`'s private `get`: this module is handed whatever URL the
 * committed calendar dataset names, follows redirects, and the CLAUDE.md rule
 * is that a URL the server will fetch needs the host policy at every HOP —
 * `fetch` follows redirects by default, so a check before the call validates
 * the URL we chose while the responder chooses where the request lands.
 * `fetchPublicUrl` takes the redirect loop back and re-runs both layers per
 * hop, which is exactly the property wanted when the thing on the other end
 * is a government CMS we do not control.
 *
 * ## The size cap is enforced on BYTES, and Content-Length is only a hint
 *
 * `Content-Length` is used to refuse early, before a body is buffered, and is
 * never trusted as the answer: it may be absent, and #3147 is the whole story
 * of a client that inferred emptiness from that header's absence. The
 * authoritative length is `byteLength` of what actually arrived, which is also
 * what gets stored and hashed. So a server that lies about the header is
 * caught by the post-read check, and a server that omits it costs one buffered
 * body bounded by the same cap.
 */
import { createHash } from 'node:crypto';

import { BlockedRequestError, fetchPublicUrl } from '@/lib/security/safe-fetch';

/**
 * 25 MB. The largest document in today's population is a ~350 KB bulletin and
 * the biggest plausible one is an annual report with photographs; the cap is
 * there to refuse a redirect to something else entirely rather than to be a
 * tight fit.
 */
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
/**
 * 25s. A government PDF over a slow link is the normal case, and this job runs
 * once a day with nothing waiting on it, so the timeout is generous on
 * purpose: a premature abort is recorded as `unreachable`, which is the one
 * outcome that would read as "the citation is broken" when it is not.
 */
export const DOCUMENT_FETCH_TIMEOUT_MS = 25_000;

/** Why a fetch did not produce bytes. Each wants a different response. */
export type DocumentFetchFailure =
    /** DNS, TLS, a timeout, a non-2xx — the document could not be read. */
    | 'unreachable'
    /** The host policy refused the URL or one of its redirect hops. */
    | 'refused'
    /** Bigger than `MAX_DOCUMENT_BYTES`, by header or by measurement. */
    | 'too-large'
    /** Reached, 2xx, and zero bytes — which is not a document. */
    | 'empty';

export interface DocumentMeasurement {
    ok: true;
    sha256: string;
    /** MEASURED byte length of the body, never a header value. */
    bytes: number;
    /** Verbatim `Content-Type`, or null when the server sent none. */
    contentType: string | null;
}

export interface DocumentFetchRefusal {
    ok: false;
    failure: DocumentFetchFailure;
    /** Operator-facing detail. Never interpolated into user copy. */
    detail: string;
}

export type DocumentFetchResult = DocumentMeasurement | DocumentFetchRefusal;

export interface DocumentFetchOptions {
    timeoutMs?: number;
    maxBytes?: number;
    /**
     * Injected in tests. Defaults to the real `fetchPublicUrl`, so a test that
     * forgets to pass one makes a network call and fails loudly rather than
     * quietly passing against a stub.
     */
    fetchImpl?: typeof fetchPublicUrl;
}

/**
 * Read a document and return its hash and measured length, or say why not.
 *
 * Never throws for a fetch problem — every failure is a value, because the
 * caller watches 13 documents in one run and one unreachable government page
 * must not end the run for the other twelve.
 */
export async function measureDocument(
    url: string,
    opts: DocumentFetchOptions = {},
): Promise<DocumentFetchResult> {
    const doFetch = opts.fetchImpl ?? fetchPublicUrl;
    const maxBytes = opts.maxBytes ?? MAX_DOCUMENT_BYTES;

    let response: Response;
    try {
        response = await doFetch(url, {
            method: 'GET',
            timeoutMs: opts.timeoutMs ?? DOCUMENT_FETCH_TIMEOUT_MS,
        });
    } catch (err) {
        // A refusal is a DIFFERENT finding from an unreachable host: one says
        // the URL is not one we will fetch, the other says the publisher did
        // not answer. Collapsing them would send somebody to check МЗХ's
        // uptime over a policy decision of ours.
        if (err instanceof BlockedRequestError) {
            return { ok: false, failure: 'refused', detail: err.message };
        }
        return { ok: false, failure: 'unreachable', detail: String(err) };
    }

    if (!response.ok) {
        return { ok: false, failure: 'unreachable', detail: `HTTP ${response.status}` };
    }

    // An early refusal on the HEADER, so an absurd document is not buffered.
    // Absent or unparseable is not a reason to refuse — see the docblock.
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
        return {
            ok: false,
            failure: 'too-large',
            detail: `declared ${declared} > ${maxBytes}`,
        };
    }

    let buffer: Buffer;
    try {
        buffer = Buffer.from(await response.arrayBuffer());
    } catch (err) {
        // A body that fails mid-stream reached us as a 2xx and is still not a
        // document, so it is `unreachable` rather than `empty`.
        return { ok: false, failure: 'unreachable', detail: `body: ${String(err)}` };
    }

    // The authoritative length. A server that under-declares its
    // Content-Length is caught here and nowhere else.
    if (buffer.byteLength > maxBytes) {
        return {
            ok: false,
            failure: 'too-large',
            detail: `measured ${buffer.byteLength} > ${maxBytes}`,
        };
    }
    if (buffer.byteLength === 0) {
        return { ok: false, failure: 'empty', detail: '0 bytes' };
    }

    return {
        ok: true,
        sha256: createHash('sha256').update(buffer).digest('hex'),
        bytes: buffer.byteLength,
        contentType: response.headers.get('content-type'),
    };
}
