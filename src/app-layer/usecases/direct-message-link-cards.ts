/**
 * Link cards in a direct conversation — P8.6 (#2800).
 *
 * A card is a SNAPSHOT of a third-party page at a moment, taken when the
 * message is sent and never refreshed. Re-fetching later would silently
 * rewrite what two people discussed, which is why `linkFetchedAt` is stored
 * beside it.
 *
 * ## Fetched SYNCHRONOUSLY, and best-effort
 *
 * The house pattern for an external fetch is a job — soil goes to SoilGrids on
 * BullMQ, `notice-score` is scheduled. This one is in the request path instead,
 * and the reason is that the card is OPTIONAL: if the fetch fails, times out,
 * or the page has no metadata, the message sends with `linkUrl` set and no
 * title. There is no state to design for "the card arrives later", no second
 * realtime publish, and no job that can silently stop running.
 *
 * What makes that safe is the bound. `fetchPublicUrl` carries a timeout, the
 * response is read under a byte cap, and every failure path returns a card
 * with nothing in it rather than throwing — so the worst case for a sender is
 * the timeout, not a refused send.
 *
 * ## The host policy runs at EVERY HOP, which is the whole point
 *
 * `fetch` follows redirects by default, so a check before the call validates
 * the URL the CALLER chose while the RESPONDER chooses where the request
 * lands — measured in this repo: a `302` to `http://127.0.0.1:9/` is followed.
 * `fetchPublicUrl` takes the redirect loop back (`redirect: 'manual'`) and
 * re-runs BOTH layers per hop: `checkWebhookUrl` (scheme plus literal host)
 * and `assertPublicAddress` (resolves DNS with `{ all: true }`, refuses if ANY
 * address is private, bounded, fails CLOSED on a resolve error).
 *
 * A scheme pin is NOT an SSRF guard — `https://169.254.169.254/` passes it —
 * which is why the payload schema's `httpsUrl()` is a contract narrowing and
 * this is the control.
 *
 * ## Whatever comes back is UNTRUSTED TEXT
 *
 * Sanitised HERE, at the usecase, not at render time: the row is also read by
 * the Art 15 export and by SDK consumers (C.5). `sanitizePlainText` TRIMS
 * since #1825, and a zero-width space survives it and is still truthy — so a
 * title of nothing but U+200B is possible and renders as an empty card rather
 * than as absent. Accepted rather than fixed, because widening past
 * `String.trim` means deciding which characters count as blank.
 */
import { codedBadRequest } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { fetchPublicUrl } from '@/lib/security/safe-fetch';

/**
 * How long the sender waits. Short on purpose: the card is optional and the
 * message is not, so a slow third-party server costs a missing preview rather
 * than a visibly stuck send.
 */
export const LINK_CARD_TIMEOUT_MS = 3_000;

/**
 * How much of the page is read. Metadata lives in `<head>`, so the first
 * 128 KB is generous — and a cap is what stops a hostile server streaming
 * forever inside the timeout.
 */
export const LINK_CARD_MAX_BYTES = 128 * 1024;

/** Stored lengths, so a hostile page cannot write a novel into a column. */
export const LINK_TITLE_MAX = 200;
export const LINK_DESCRIPTION_MAX = 500;

export interface LinkCard {
    readonly url: string;
    readonly title: string | null;
    readonly description: string | null;
    readonly fetchedAt: Date | null;
}

/** An `https:` URL, or a refusal. The payload schema narrows this too. */
export function requireHttpsUrl(raw: string): string {
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw codedBadRequest('DM_LINK_URL_INVALID', 'That is not a link we can read.');
    }
    // `https:` only, checked here as well as in the schema. The schema is the
    // contract; this is the function that actually fetches, and a second
    // caller arriving without the schema is the case this covers.
    if (parsed.protocol !== 'https:') {
        throw codedBadRequest('DM_LINK_URL_INVALID', 'That is not a link we can read.');
    }
    return parsed.toString();
}

/** Read at most `LINK_CARD_MAX_BYTES` of a response body as text. */
async function readCapped(res: Response): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        chunks.push(value);
        total += value.byteLength;
        if (total >= LINK_CARD_MAX_BYTES) {
            // Cancelled rather than drained: a hostile server streaming
            // forever is bounded by the timeout, but there is no reason to
            // keep reading bytes already past the cap.
            await reader.cancel().catch(() => undefined);
            break;
        }
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * The FIRST match for each tag, Open Graph preferred.
 *
 * Deliberately a small regex pass rather than an HTML parser: the subject is
 * two attributes in `<head>`, the input is capped at 128 KB, and adding a
 * parser would add a dependency that decodes hostile markup for no gain. What
 * it does NOT do is interpret anything — the value goes straight to
 * `sanitizePlainText`, which strips every tag, so a malformed match costs a
 * wrong title rather than markup reaching a reader.
 */
function extractMeta(html: string, names: readonly string[]): string | null {
    for (const name of names) {
        const re = new RegExp(
            `<meta[^>]+(?:property|name)\\s*=\\s*["']${name}["'][^>]*content\\s*=\\s*["']([^"']*)["']`,
            'i',
        );
        const m = re.exec(html);
        if (m?.[1]) return m[1];
        // The attribute order is not fixed, so try `content` first too.
        const flipped = new RegExp(
            `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:property|name)\\s*=\\s*["']${name}["']`,
            'i',
        );
        const m2 = flipped.exec(html);
        if (m2?.[1]) return m2[1];
    }
    return null;
}

function clean(raw: string | null, max: number): string | null {
    if (raw === null) return null;
    // SANITISED at the usecase, because the row is read by the export and by
    // SDK consumers too — not only by a renderer (C.5).
    const text = sanitizePlainText(raw);
    if (!text) return null;
    return text.length > max ? text.slice(0, max) : text;
}

/**
 * Fetch one link card. NEVER throws for a fetch failure.
 *
 * The URL itself is validated and can throw — a caller passing something that
 * is not `https:` is a bad request. Everything after that is best-effort: a
 * refused host, a timeout, a non-2xx, a page with no metadata and a body that
 * is not HTML all produce a card carrying the URL and nothing else.
 */
export async function fetchLinkCard(rawUrl: string): Promise<LinkCard> {
    return _fetchCardAt(requireHttpsUrl(rawUrl));
}

/**
 * The bounded fetch, given an ALREADY-VALIDATED URL. Callers use
 * `fetchLinkCard`.
 *
 * Exported with an `_` prefix as a TEST SEAM — the `_resetDnsVerdictCache`
 * precedent one module over. The suite that proves the per-hop refusal has to
 * drive a real `http.Server` on loopback, because the subject is what undici
 * does with a `Location` header and a mocked fetch would assert my
 * understanding of undici back to me. `requireHttpsUrl` correctly refuses
 * that URL, so the scheme contract and the fetch are separate functions:
 * each is then testable WITHOUT an env-conditional hole in either, which is
 * what a `NODE_ENV`-gated loopback exemption inside the scheme pin would be.
 */
export async function _fetchCardAt(url: string): Promise<LinkCard> {
    try {
        const res = await fetchPublicUrl(url, {
            timeoutMs: LINK_CARD_TIMEOUT_MS,
            // A browser-ish accept header, so a server that negotiates sends
            // HTML rather than its API representation.
            headers: { accept: 'text/html,application/xhtml+xml' },
        });

        if (!res.ok) return { url, title: null, description: null, fetchedAt: new Date() };

        const type = res.headers.get('content-type') ?? '';
        if (!/^text\/html|^application\/xhtml\+xml/i.test(type)) {
            // Not a page. Reading an image or a PDF looking for `<meta>` would
            // be pointless and would pull its bytes through the request path.
            return { url, title: null, description: null, fetchedAt: new Date() };
        }

        const html = await readCapped(res);
        return {
            url,
            title: clean(
                extractMeta(html, ['og:title', 'twitter:title'])
                    ?? /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]
                    ?? null,
                LINK_TITLE_MAX,
            ),
            description: clean(
                extractMeta(html, ['og:description', 'twitter:description', 'description']),
                LINK_DESCRIPTION_MAX,
            ),
            fetchedAt: new Date(),
        };
    } catch (err) {
        // Includes `BlockedRequestError` — a URL that resolved to a private
        // address, at the FIRST hop or any later one. Logged without the host,
        // because a refusal naming what it refused is a probe's answer.
        logger.info('dm.link_card_unavailable', {
            component: 'direct-message-link-cards',
            reason: err instanceof Error ? err.name : 'unknown',
        });
        return { url, title: null, description: null, fetchedAt: null };
    }
}
