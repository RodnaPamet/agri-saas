/**
 * Link cards in a direct conversation — P8.6 (#2800).
 *
 * ## Why these drive a REAL server
 *
 * The whole subject is what happens to a third party's response: a redirect, a
 * content type, a body larger than the cap. A mocked `fetch` would assert my
 * understanding of undici back to me — "a mocked dependency cannot report that
 * the dependency changed" — so every case stands up an actual `http.Server` on
 * loopback, the same approach `safe-fetch.test.ts` takes and for the same
 * reason.
 *
 * `checkWebhookUrl` is stubbed to a pass-through so the suite can talk to
 * loopback at all, while the DNS layer stays honest through a mocked resolver.
 * The host RULES are exercised for real in `webhook-safety.test.ts` (36
 * cases); what this file is about is whether the LINK-CARD path inherits the
 * per-hop refusal rather than only the first URL's.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

jest.mock('@/app-layer/automation/webhook-safety', () => {
    const actual = jest.requireActual('@/app-layer/automation/webhook-safety');
    return {
        ...actual,
        checkWebhookUrl: (url: string) => {
            try {
                return { ok: true, host: new URL(url).hostname };
            } catch {
                return { ok: false, reason: 'malformed URL' };
            }
        },
        assertPublicAddress: (host: string) =>
            Promise.resolve(
                blockedHosts.has(host)
                    ? { ok: false, reason: `${host} resolves to private 10.0.0.5`, host }
                    : { ok: true, host },
            ),
    };
});

const blockedHosts = new Set<string>();

import { _resetDnsVerdictCache } from '@/app-layer/automation/webhook-safety';
import {
    fetchLinkCard,
    _fetchCardAt,
    requireHttpsUrl,
    LINK_TITLE_MAX,
    LINK_DESCRIPTION_MAX,
} from '@/app-layer/usecases/direct-message-link-cards';

interface Server {
    url: string;
    hits: string[];
    close: () => Promise<void>;
}

const servers: Server[] = [];

/**
 * `host` defaults to `127.0.0.1`. The redirect case needs a SECOND, distinct
 * hostname, because the DNS stub keys its refusal on the host — two servers
 * on `127.0.0.1` are indistinguishable to it, so blocking the target would
 * block the hop as well and the test would pass for the wrong reason (it did:
 * `hop.hits` was 0, meaning the first request never left). `127.0.0.2` is in
 * loopback/8 and binds on Linux.
 */
async function start(handler: http.RequestListener, host = '127.0.0.1'): Promise<Server> {
    const hits: string[] = [];
    const srv = http.createServer((req, res) => {
        hits.push(req.url ?? '');
        handler(req, res);
    });
    await new Promise<void>((resolve) => srv.listen(0, host, resolve));
    const { port } = srv.address() as AddressInfo;
    const s: Server = {
        url: `http://${host}:${port}`,
        hits,
        close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
    };
    servers.push(s);
    return s;
}

function html(res: http.ServerResponse, body: string): void {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
}

afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
    blockedHosts.clear();
    _resetDnsVerdictCache();
});

describe('the URL contract', () => {
    it('refuses anything that is not https', () => {
        for (const bad of ['http://example.test/x', 'file:///etc/passwd', 'javascript:alert(1)']) {
            expect(() => requireHttpsUrl(bad)).toThrow();
        }
    });

    it('accepts an https URL', () => {
        expect(requireHttpsUrl('https://example.test/a?b=1')).toBe('https://example.test/a?b=1');
    });

    it('COMPOSES the two halves — a valid scheme reaches the fetch', async () => {
        // The cases below drive the seam directly, so this is what proves
        // `fetchLinkCard` is wired to it at all: an https URL gets PAST the
        // scheme pin and then fails in the fetch, which is a `fetchedAt` of
        // null rather than a throw. Port 1 on loopback refuses immediately,
        // so no DNS and no timeout are involved.
        const card = await fetchLinkCard('https://127.0.0.1:1/x');
        expect(card.url).toBe('https://127.0.0.1:1/x');
        expect(card.fetchedAt).toBeNull();
    });
});

describe('fetchLinkCard — the per-hop refusal is INHERITED', () => {
    it('reads Open Graph metadata from a page', async () => {
        const srv = await start((_req, res) =>
            html(
                res,
                '<html><head>'
                    + '<meta property="og:title" content="Цени на пшеница">'
                    + '<meta property="og:description" content="Седмичен обзор">'
                    + '</head></html>',
            ),
        );

        // The POSITIVE CONTROL every refusal below needs: a card CAN be read.
        // Without it, "no title" would be satisfied by a fetcher that never
        // worked at all.
        const card = await _fetchCardAt(`${srv.url}/page`);
        expect(card.title).toBe('Цени на пшеница');
        expect(card.description).toBe('Седмичен обзор');
        expect(card.fetchedAt).not.toBeNull();
    });

    it('REFUSES a redirect into a host that resolves privately — at the HOP', async () => {
        const target = await start((_req, res) => html(res, '<title>never read</title>'), '127.0.0.2');
        const hop = await start((_req, res) => {
            res.writeHead(302, { location: `${target.url}/secret` });
            res.end();
        });
        // The first URL is fine; the SECOND is not. A check performed only
        // before the call would pass this and land on the private host, which
        // is the defect #708 measured.
        blockedHosts.add(new URL(target.url).hostname);

        const card = await _fetchCardAt(`${hop.url}/start`);

        // Best-effort: the card is empty rather than the send being refused.
        expect(card.title).toBeNull();
        expect(card.description).toBeNull();
        // `fetchedAt` NULL is how a refused fetch is told apart from a page
        // that simply had no metadata — the latter stamps a time.
        expect(card.fetchedAt).toBeNull();
        // And the proof it was refused AT THE HOP rather than never attempted:
        // the first server was reached, the second was not.
        expect(hop.hits).toHaveLength(1);
        expect(target.hits).toHaveLength(0);
    });

    it('a page with no metadata stamps a time and carries no title', async () => {
        const srv = await start((_req, res) => html(res, '<html><head></head><body>hi</body></html>'));
        const card = await _fetchCardAt(`${srv.url}/bare`);
        expect(card.title).toBeNull();
        // Distinguishable from the refusal above, which is why this stamps.
        expect(card.fetchedAt).not.toBeNull();
    });

    it('does not read a non-HTML response at all', async () => {
        const srv = await start((_req, res) => {
            res.writeHead(200, { 'content-type': 'image/jpeg' });
            res.end(Buffer.from('<title>not really html</title>'));
        });
        const card = await _fetchCardAt(`${srv.url}/photo.jpg`);
        // Looking for `<meta>` in an image would be pointless AND would pull
        // its bytes through the request path.
        expect(card.title).toBeNull();
    });

    it('returns an empty card on a non-2xx rather than throwing', async () => {
        const srv = await start((_req, res) => {
            res.writeHead(500);
            res.end('boom');
        });
        const card = await _fetchCardAt(`${srv.url}/broken`);
        expect(card.title).toBeNull();
        expect(card.url).toContain('/broken');
    });
});

describe('whatever comes back is UNTRUSTED TEXT', () => {
    it('does NOT sanitise — the caller does, exactly once (#2874)', async () => {
        const srv = await start((_req, res) =>
            html(
                res,
                '<html><head><meta property="og:title" '
                    + 'content="<img src=x onerror=alert(1)>Пшеница"></head></html>',
            ),
        );
        const card = await _fetchCardAt(`${srv.url}/x`);
        // THE FETCHER HANDS BACK WHAT THE PAGE SERVED, trimmed and capped.
        //
        // It used to sanitise here AND the write sanitised again by name — two
        // passes over one value, defended as free because the function is
        // "idempotent". Measured, it is not: each pass strips tags and then
        // decodes one entity level, so a doubly-encoded payload reaches
        // literal `<script>` on the second pass. One pass, at the write, where
        // `sanitize-rich-text-coverage` verifies the field by name.
        //
        // So the raw tag is still here. The assertion that it does not reach
        // the ROW is `p8-6-dm-link-cards` → "SANITISES the card text, asserted
        // on the STORED row", which is the one that matters.
        expect(card.title).toBe('<img src=x onerror=alert(1)>Пшеница');
    });

    it('passes an ENTITY-ENCODED tag through untouched — #2854 owns the decode', async () => {
        const srv = await start((_req, res) =>
            html(
                res,
                '<html><head><meta property="og:title" '
                    + 'content="&lt;script&gt;a&lt;/script&gt;"></head></html>',
            ),
        );
        const card = await _fetchCardAt(`${srv.url}/entity`);
        // The fetcher is a transport: it extracts, trims and caps. What the
        // ENCODED form becomes is the sanitiser's business, and the sanitiser
        // runs once at the write.
        //
        // The regex captures the attribute's bytes as served, so the entities
        // are still entities here. #2854 is the ordering defect in
        // `sanitizePlainText` itself — it strips tags and THEN decodes one
        // entity level, which is why running it twice was worse than running
        // it once (#2874) and why a doubly-encoded payload is its hard case.
        expect(card.title).toBe('&lt;script&gt;a&lt;/script&gt;');
    });

    it('caps a hostile title and description', async () => {
        const srv = await start((_req, res) =>
            html(
                res,
                '<html><head>'
                    + `<meta property="og:title" content="${'я'.repeat(5000)}">`
                    + `<meta property="og:description" content="${'о'.repeat(5000)}">`
                    + '</head></html>',
            ),
        );
        const card = await _fetchCardAt(`${srv.url}/long`);
        expect(card.title!.length).toBe(LINK_TITLE_MAX);
        expect(card.description!.length).toBe(LINK_DESCRIPTION_MAX);
    });

    it('falls back to <title> when there is no Open Graph tag', async () => {
        const srv = await start((_req, res) =>
            html(res, '<html><head><title>Обикновено заглавие</title></head></html>'),
        );
        const card = await _fetchCardAt(`${srv.url}/plain`);
        expect(card.title).toBe('Обикновено заглавие');
    });

    it('reads a meta tag whose attributes are in the other order', async () => {
        const srv = await start((_req, res) =>
            html(res, '<html><head><meta content="Обратен ред" property="og:title"></head></html>'),
        );
        // `content` before `property` is valid HTML and common enough that a
        // single-order regex would silently miss it.
        const card = await _fetchCardAt(`${srv.url}/flipped`);
        expect(card.title).toBe('Обратен ред');
    });
});
