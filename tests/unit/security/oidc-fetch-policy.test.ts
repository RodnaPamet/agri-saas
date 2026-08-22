/**
 * The OIDC client's two outbound fetches carry the SSRF policy (#708).
 *
 * `tests/unit/security/safe-fetch.test.ts` proves the MECHANISM. This file
 * proves the two CALL SITES are wired to it with the right budgets — which is
 * a separate claim, and one a mutation caught me not making: flipping the
 * token exchange from `maxRedirects: 0` to `3` left every other suite green.
 *
 * Real servers again, for the reason the sibling file gives: the behaviour
 * under test is `undici`'s redirect handling, and a mocked fetch would only
 * assert my understanding of it back to me.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
    discoverOidc,
    exchangeCodeForTokens,
    type OidcDiscoveryDocument,
} from '@/lib/security/oidc-client';
import type { OidcConfig } from '@/app-layer/schemas/sso-config.schemas';

// The host rules are exercised for real in `webhook-safety.test.ts`; this
// suite must reach loopback, so they pass through here. The redirect budget —
// what this file is about — is untouched.
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
        assertPublicAddress: (host: string) => Promise.resolve({ ok: true, host }),
    };
});

interface Server {
    url: string;
    hits: Array<{ path: string; body: string }>;
    close: () => Promise<void>;
}

const servers: Server[] = [];

async function start(handler: http.RequestListener): Promise<Server> {
    const hits: Array<{ path: string; body: string }> = [];
    const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            hits.push({ path: req.url ?? '', body });
            handler(req, res);
        });
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const { port } = srv.address() as AddressInfo;
    const s: Server = {
        url: `http://127.0.0.1:${port}`,
        hits,
        close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
    };
    servers.push(s);
    return s;
}

afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
    jest.resetModules();
});

const config = (over: Partial<OidcConfig> = {}): OidcConfig =>
    ({
        issuer: 'https://idp.example.com',
        clientId: 'cid',
        // Fixture. This literal is the thing the suite asserts is NOT re-sent
        // to a redirect target, so it has to be greppable in the request body
        // for that assertion to mean anything.
        clientSecret: 'super-secret-value', // pragma: allowlist secret
        scopes: ['openid'],
        ...over,
    }) as OidcConfig;

describe('exchangeCodeForTokens refuses to follow a redirect', () => {
    it('never re-sends client_secret to a host the responder chose', async () => {
        // The threat: the token POST carries `client_secret`. If the endpoint
        // answers 307, following it would repeat the body — credential
        // included — to whatever host the Location names. A token endpoint has
        // no legitimate reason to redirect, so this is refused outright.
        const attacker = await start((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"id_token":"x","access_token":"y","token_type":"Bearer"}');
        });
        const idp = await start((_req, res) => {
            res.writeHead(307, { Location: `${attacker.url}/collect` });
            res.end();
        });

        const discovery = {
            issuer: 'https://idp.example.com',
            authorization_endpoint: `${idp.url}/authorize`,
            token_endpoint: `${idp.url}/token`,
            jwks_uri: `${idp.url}/jwks`,
        } as OidcDiscoveryDocument;

        await expect(
            exchangeCodeForTokens(discovery, config(), 'code-abc', 'https://app/cb', 'verifier'),
        ).rejects.toThrow();

        // The assertion that matters, and the one the mutation exposed as
        // missing: the secret never reached the second host.
        expect(attacker.hits).toEqual([]);
        // …and it really was sent to the FIRST one, so this is not passing
        // because the exchange never ran.
        expect(idp.hits).toHaveLength(1);
        expect(idp.hits[0].body).toContain('client_secret=super-secret-value');
    });

    it('succeeds normally when the endpoint does not redirect', async () => {
        // Resolving power: without this, the test above is satisfied by an
        // exchange that always throws.
        const idp = await start((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"id_token":"idt","access_token":"at","token_type":"Bearer"}');
        });
        const discovery = {
            issuer: 'https://idp.example.com',
            authorization_endpoint: `${idp.url}/authorize`,
            token_endpoint: `${idp.url}/token`,
            jwks_uri: `${idp.url}/jwks`,
        } as OidcDiscoveryDocument;

        const tokens = await exchangeCodeForTokens(
            discovery,
            config(),
            'code-abc',
            'https://app/cb',
            'verifier',
        );
        expect(tokens.id_token).toBe('idt');
    });
});

describe('discoverOidc DOES follow a redirect, because issuers use them', () => {
    it('follows to the document and returns it', async () => {
        const real = await start((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
                JSON.stringify({
                    issuer: 'https://idp.example.com',
                    authorization_endpoint: 'https://idp.example.com/authorize',
                    token_endpoint: 'https://idp.example.com/token',
                    jwks_uri: 'https://idp.example.com/jwks',
                }),
            );
        });
        const entry = await start((_req, res) => {
            res.writeHead(302, { Location: `${real.url}/real-config` });
            res.end();
        });

        const doc = await discoverOidc(config({ discoveryUrl: `${entry.url}/.well-known` }));
        expect(doc.issuer).toBe('https://idp.example.com');
        expect(real.hits.map((h) => h.path)).toEqual(['/real-config']);
    });
});
