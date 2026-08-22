/**
 * `fetchPublicUrl` — the SSRF policy survives a redirect (#708).
 *
 * WHY THESE DRIVE A REAL SERVER. The whole defect is about what `fetch` does
 * with a `Location` header, which is `undici`'s behaviour, not ours. A mocked
 * fetch would assert my understanding of undici back to me — the shape
 * CLAUDE.md warns about: "a mocked dependency cannot report that the
 * dependency changed". So every case below stands up an actual `http.Server`
 * on loopback and lets the real client follow (or refuse) real redirects.
 *
 * The measurement that motivated the module, reproduced by the first test:
 *
 *     redirect:follow   -> the request LANDED on 127.0.0.1
 *     redirect:manual   -> 302 returned, Location intact for us to inspect
 *
 * So a host check performed before a plain `fetch` is worth nothing: it
 * validates the URL the caller chose, while the responder chooses the URL the
 * request actually reaches.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
    fetchPublicUrl,
    BlockedRequestError,
} from '@/lib/security/safe-fetch';
import {
    _resetDnsVerdictCache,
} from '@/app-layer/automation/webhook-safety';

/**
 * The policy refuses non-https and private literals, and this suite has to
 * talk to loopback. So `checkWebhookUrl` is exercised for real elsewhere
 * (`tests/unit/webhook-safety.test.ts`, 36 cases) and stubbed here to a
 * pass-through, EXCEPT that we keep the DNS layer honest by driving
 * `assertPublicAddress` through a mocked resolver. What this file is about is
 * the redirect loop, not the host rules.
 */
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

/** Hosts the stubbed DNS layer treats as resolving into private space. */
const blockedHosts = new Set<string>();

interface Server {
    url: string;
    hits: string[];
    close: () => Promise<void>;
}

async function serve(handler: http.RequestListener): Promise<Server> {
    const hits: string[] = [];
    const srv = http.createServer((req, res) => {
        hits.push(req.url ?? '');
        handler(req, res);
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const { port } = srv.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        hits,
        close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
    };
}

const servers: Server[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
    blockedHosts.clear();
    _resetDnsVerdictCache();
});

async function start(handler: http.RequestListener): Promise<Server> {
    const s = await serve(handler);
    servers.push(s);
    return s;
}

describe('the premise: plain fetch follows a redirect wherever it is told', () => {
    it('a default fetch LANDS on the redirect target', async () => {
        const target = await start((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"landed":true}');
        });
        const origin = await start((_req, res) => {
            res.writeHead(302, { Location: `${target.url}/internal` });
            res.end();
        });

        const res = await fetch(`${origin.url}/start`, { redirect: 'follow' });
        expect(res.status).toBe(200);
        // The proof: the SECOND server saw the request, chosen by the FIRST.
        expect(target.hits).toEqual(['/internal']);
    });
});

describe('fetchPublicUrl — per-hop enforcement', () => {
    it('returns a non-redirect response unchanged', async () => {
        const srv = await start((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"ok":true}');
        });
        const res = await fetchPublicUrl(`${srv.url}/x`);
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ ok: true });
    });

    it('follows a redirect and re-checks the hop', async () => {
        const target = await start((_req, res) => {
            res.writeHead(200);
            res.end('arrived');
        });
        const origin = await start((_req, res) => {
            res.writeHead(302, { Location: `${target.url}/next` });
            res.end();
        });
        const res = await fetchPublicUrl(`${origin.url}/start`);
        expect(res.status).toBe(200);
        expect(target.hits).toEqual(['/next']);
    });

    it('REFUSES a redirect into a host that resolves privately', async () => {
        // The defect this module exists for: hop 1 is fine, hop 2 is not, and
        // nothing but a per-hop check could know that.
        //
        // The two servers must have DIFFERENT host strings or this passes
        // vacuously — my first version put both on `127.0.0.1` and blocked
        // that host, so the refusal happened at hop 0 and the redirect was
        // never exercised at all. `localhost` and `127.0.0.1` are the same
        // machine and different names, which is exactly the distinction a host
        // policy operates on.
        const target = await start((_req, res) => {
            res.writeHead(200);
            res.end('should never be reached');
        });
        const origin = await start((_req, res) => {
            res.writeHead(302, { Location: `${target.url}/internal` });
            res.end();
        });
        const originViaName = origin.url.replace('127.0.0.1', 'localhost');
        blockedHosts.add('127.0.0.1'); // the redirect TARGET only

        await expect(fetchPublicUrl(`${originViaName}/start`)).rejects.toThrow(
            BlockedRequestError,
        );
        // Resolving power, both directions: hop 1 really was allowed and
        // really did happen…
        expect(origin.hits).toEqual(['/start']);
        // …and hop 2 really was refused before any request left.
        expect(target.hits).toEqual([]);
    });

    it('and the same chain SUCCEEDS when the second hop is allowed', async () => {
        // Without this, the test above is satisfied by a module that refuses
        // every redirect for any reason.
        const target = await start((_req, res) => {
            res.writeHead(200);
            res.end('arrived');
        });
        const origin = await start((_req, res) => {
            res.writeHead(302, { Location: `${target.url}/internal` });
            res.end();
        });
        const res = await fetchPublicUrl(`${origin.url.replace('127.0.0.1', 'localhost')}/start`);
        expect(res.status).toBe(200);
        expect(target.hits).toEqual(['/internal']);
    });

    it('refuses a redirect chain longer than the budget', async () => {
        let n = 0;
        const srv = await start((_req, res) => {
            n += 1;
            res.writeHead(302, { Location: `/hop${n}` });
            res.end();
        });
        await expect(
            fetchPublicUrl(`${srv.url}/start`, { maxRedirects: 2 }),
        ).rejects.toThrow(/too many redirects/);
        // start + 2 permitted hops = 3 requests, then refusal.
        expect(srv.hits.length).toBe(3);
    });

    it('resolves a relative Location against the CURRENT hop, not the original URL', async () => {
        // Two hops on DIFFERENT hosts, where the second issues a relative
        // Location. Resolving it against `rawUrl` would send hop 3 back to the
        // first server; resolving against the current hop keeps it on the
        // second. A single-hop version of this test cannot tell the two apart
        // — mine did not, and the mutation walked straight through it.
        const second = await start((req, res) => {
            if (req.url === '/b') {
                res.writeHead(302, { Location: '/b-final' }); // relative
                res.end();
                return;
            }
            res.writeHead(200);
            res.end('second-server');
        });
        const first = await start((_req, res) => {
            res.writeHead(302, { Location: `${second.url.replace('127.0.0.1', 'localhost')}/b` });
            res.end();
        });

        const res = await fetchPublicUrl(`${first.url}/start`);
        expect(res.status).toBe(200);
        await expect(res.text()).resolves.toBe('second-server');
        // The whole point: the final hop landed on the SECOND server.
        expect(second.hits).toEqual(['/b', '/b-final']);
        expect(first.hits).toEqual(['/start']);
    });

    it('resolves a relative Location within a single host too', async () => {
        const srv = await start((req, res) => {
            if (req.url === '/start') {
                res.writeHead(302, { Location: '/deep/target' }); // relative
                res.end();
                return;
            }
            res.writeHead(200);
            res.end('ok');
        });
        const res = await fetchPublicUrl(`${srv.url}/start`);
        expect(res.status).toBe(200);
        expect(srv.hits).toEqual(['/start', '/deep/target']);
    });

    it('a 3xx with no Location is returned, not treated as a hop', async () => {
        const srv = await start((_req, res) => {
            res.writeHead(302);
            res.end();
        });
        const res = await fetchPublicUrl(`${srv.url}/x`);
        expect(res.status).toBe(302);
    });
});

describe('maxRedirects: 0 — for a request whose BODY carries a credential', () => {
    it('refuses to follow, and the secret never leaves the first host', async () => {
        // This is the token-exchange shape. The body carries `client_secret`;
        // following a redirect would re-send it to a host the responder chose.
        const attacker = await start((_req, res) => {
            res.writeHead(200);
            res.end('{"access_token":"stolen"}');
        });
        const idp = await start((_req, res) => {
            res.writeHead(307, { Location: `${attacker.url}/collect` });
            res.end();
        });

        await expect(
            fetchPublicUrl(`${idp.url}/token`, {
                method: 'POST',
                // Fixture standing in for a credential-bearing body.
                body: 'client_secret=super-secret&code=abc', // pragma: allowlist secret
                maxRedirects: 0,
            }),
        ).rejects.toThrow(/refused to follow a redirect/);

        // The assertion that matters: the credential was never transmitted.
        expect(attacker.hits).toEqual([]);
    });

    it('still returns a normal 200 — the budget only bans redirects', () => {
        return start((_req, res) => {
            res.writeHead(200);
            res.end('{"access_token":"legit"}');
        }).then(async (srv) => {
            const res = await fetchPublicUrl(`${srv.url}/token`, {
                method: 'POST',
                body: 'x=1',
                maxRedirects: 0,
            });
            expect(res.status).toBe(200);
        });
    });
});
