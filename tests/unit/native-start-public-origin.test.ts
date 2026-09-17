/**
 * `/api/auth/native/start` must build its redirect from the PUBLIC origin.
 *
 * Measured in production on 2026-09-17, immediately after
 * NATIVE_AUTH_REDIRECT_ALLOWLIST was set and the route stopped answering 400:
 *
 *   GET https://app.agrent.bg/api/auth/native/start?redirect_uri=bg.agrent.app%3A%2F%2Fauth%2Fcallback&…
 *     → 307  Location: https://0.0.0.0:3000/api/auth/signin/google
 *                       ?callbackUrl=https%3A%2F%2F0.0.0.0%3A3000%2Fapi%2Fauth%2Fnative%2Fcomplete
 *
 * `0.0.0.0:3000` is the container's own bind address. The device following
 * that redirect — an ASWebAuthenticationSession on a phone — cannot reach it,
 * so native sign-in could never complete. This was NOT a deployment fault:
 * APP_URL, NEXTAUTH_URL and AUTH_URL are all `https://app.agrent.bg` inside the
 * container and Caddy forwards `Host {host}` + `X-Forwarded-Proto {scheme}`.
 * The route derived its origin from `new URL(req.url)` and discarded them.
 *
 * The 400 had hidden this for as long as the allowlist was unset: the route
 * refused before it ever built a redirect, so the bug had no observable.
 *
 * These are UNIT tests on purpose. `tests/integration/native-oauth-handoff`
 * covers /complete and /exchange but is gated on DB_AVAILABLE, and a skipped
 * suite is a pass — this defect needs a test that cannot be silenced by a
 * missing database.
 */
import { NextRequest } from 'next/server';

jest.mock('@/env', () => ({
    env: {
        NATIVE_AUTH_REDIRECT_ALLOWLIST: 'bg.agrent.app://auth/callback',
        APP_URL: 'https://app.agrent.bg',
    },
}));
jest.mock('@/lib/errors/api', () => ({
    // Pass through, so these tests exercise the handler rather than the
    // rate-limit wrapper. The wrapper is not what regressed.
    withApiErrorHandling: (handler: unknown) => handler,
}));
jest.mock('@/lib/security/rate-limit', () => ({ LOGIN_LIMIT: { windowMs: 1, max: 1 } }));
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { env } from '@/env';
import { GET } from '@/app/api/auth/native/start/route';

const PUBLIC_ORIGIN = 'https://app.agrent.bg';
/** What `req.url` actually is inside the container behind the proxy. */
const CONTAINER_ORIGIN = 'https://0.0.0.0:3000';
const REDIRECT = 'bg.agrent.app://auth/callback';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

function startReq(origin: string, overrides: Record<string, string> = {}) {
    const u = new URL('/api/auth/native/start', origin);
    const params: Record<string, string> = {
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
        provider: 'google',
        ...overrides,
    };
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return new NextRequest(u.toString());
}

async function locationOf(req: NextRequest): Promise<URL> {
    const res = (await (GET as unknown as (r: NextRequest) => Promise<Response>)(req));
    expect(res.status).toBe(307);
    const loc = res.headers.get('location');
    expect(loc).toBeTruthy();
    return new URL(loc!);
}

describe('native/start builds redirects from the public origin', () => {
    beforeEach(() => {
        (env as { APP_URL?: string }).APP_URL = PUBLIC_ORIGIN;
    });

    it('the signin redirect targets the public origin, NOT the request origin', async () => {
        const loc = await locationOf(startReq(CONTAINER_ORIGIN));
        expect(loc.origin).toBe(PUBLIC_ORIGIN);
        expect(loc.pathname).toBe('/api/auth/signin/google');
        // The exact production symptom, named so a regression is unmistakable.
        expect(loc.href).not.toContain('0.0.0.0');
    });

    it('the callbackUrl ALSO targets the public origin', async () => {
        // A fix that repointed only the outer URL would pass the test above
        // and still strand the browser on the way back. Separate construction,
        // separate assertion.
        const loc = await locationOf(startReq(CONTAINER_ORIGIN));
        const callback = new URL(loc.searchParams.get('callbackUrl')!);
        expect(callback.origin).toBe(PUBLIC_ORIGIN);
        expect(callback.pathname).toBe('/api/auth/native/complete');
        expect(callback.href).not.toContain('0.0.0.0');
    });

    it('falls back to the request origin when APP_URL is unset (local dev)', async () => {
        delete (env as { APP_URL?: string }).APP_URL;
        const loc = await locationOf(startReq('http://localhost:3000'));
        expect(loc.origin).toBe('http://localhost:3000');
    });

    it('CONTROL: the open-redirect gate still refuses an unlisted scheme', async () => {
        // Proves the change did not widen the thing this route exists to guard.
        const res = (await (GET as unknown as (r: NextRequest) => Promise<Response>)(
            startReq(CONTAINER_ORIGIN, { redirect_uri: 'bg.evil.app://auth/callback' }),
        ));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('redirect_uri_not_allowed');
    });
});
