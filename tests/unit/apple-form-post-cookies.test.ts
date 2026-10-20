/**
 * Apple's cross-site form_post needs its check cookies to be `SameSite=None`
 * — #2096.
 *
 * ## The failure this fixes
 *
 * Measured by the owner twice on 2026-10-20: «Sign in with Apple» appears on
 * the web, Apple's page appears, they authenticate and confirm — and the
 * browser lands back on the login screen with no message.
 *
 * Apple's `form_post` response mode means the callback arrives as a
 * CROSS-SITE POST rather than a top-level GET navigation. `SameSite=Lax`
 * permits the latter and refuses the former, and next-auth v4 defaults both
 * `next-auth.pkce.code_verifier` and `next-auth.state` to `Lax`. So they are
 * simply absent on the callback, the PKCE/state check fails, and v4 redirects
 * to the sign-in page naming nothing.
 *
 * Deterministic, not flaky: a Lax cookie is NEVER sent on a cross-site POST,
 * so it failed every attempt and would have failed for every user. The
 * provider was correctly registered the whole time, which is what made this
 * look like a bad key.
 *
 * ## Why the names are read from next-auth rather than written here
 *
 * An override whose name does not match the default is not an override — the
 * cookie is written under one name and looked for under another, and the
 * symptom is identical to having changed nothing. Transcribing the two names
 * would be a test that passes while the fix does nothing after an upgrade
 * renames them, so they are extracted from `next-auth/core/lib/cookie.js`
 * itself. That module is not importable (`ERR_PACKAGE_PATH_NOT_EXPORTED`),
 * hence reading the source.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {}, prisma: {} }));

/** The cookie names next-auth v4 itself uses, read from its own source. */
function nextAuthDefaultNames(): { pkce: string; state: string; session: string } {
    const src = readFileSync(
        path.join(process.cwd(), 'node_modules/next-auth/core/lib/cookie.js'),
        'utf8',
    );
    const grab = (key: string) => {
        const m = new RegExp(`${key}:\\s*\\{\\s*name:\\s*\`\\$\\{cookiePrefix\\}([^\`]+)\``).exec(src);
        if (!m) throw new Error(`next-auth cookie default not found: ${key}`);
        return m[1];
    };
    return { pkce: grab('pkceCodeVerifier'), state: grab('state'), session: grab('sessionToken') };
}

type CookieOpts = { sameSite?: string; secure?: boolean; httpOnly?: boolean; path?: string; maxAge?: number };
type Cookies = Record<string, { name: string; options: CookieOpts }>;

function optionsFor(nextAuthUrl: string): Cookies {
    let cookies: Cookies = {};
    const previous = process.env.NEXTAUTH_URL;
    process.env.NEXTAUTH_URL = nextAuthUrl;
    jest.resetModules();
    jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- the
        // whole point is a FRESH module: `authOptions` is a module-level const
        // and reads the URL at import, so a static import would pin whichever
        // value the first test happened to set.
        const { authOptions } = require('@/auth');
        cookies = (authOptions.cookies ?? {}) as Cookies;
    });
    if (previous === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = previous;
    return cookies;
}

const DEFAULTS = nextAuthDefaultNames();

describe('the OAuth check cookies over HTTPS', () => {
    const cookies = optionsFor('https://app.agrent.bg');

    it('names them exactly as next-auth does, prefix included', () => {
        // Read from next-auth's source, so an upgrade that renames them fails
        // here rather than leaving an override that silently does nothing.
        expect(cookies.pkceCodeVerifier.name).toBe(`__Secure-${DEFAULTS.pkce}`);
        expect(cookies.state.name).toBe(`__Secure-${DEFAULTS.state}`);
    });

    it('sends them on a cross-site POST, which is what Apple does', () => {
        for (const key of ['pkceCodeVerifier', 'state'] as const) {
            expect(cookies[key].options.sameSite).toBe('none');
            // `SameSite=None` without `Secure` is rejected by every browser,
            // so these two travel together or not at all.
            expect(cookies[key].options.secure).toBe(true);
        }
    });

    it('keeps every other default, so overriding sameSite drops nothing', () => {
        for (const key of ['pkceCodeVerifier', 'state'] as const) {
            expect(cookies[key].options.httpOnly).toBe(true);
            expect(cookies[key].options.path).toBe('/');
            // next-auth's own 15 minutes. An override that forgot it would
            // turn a short-lived check cookie into a session-length one.
            expect(cookies[key].options.maxAge).toBe(60 * 15);
        }
    });

    it('does NOT widen the session cookie', () => {
        // The negative that bounds the change. The session cookie is not part
        // of an OAuth callback, so relaxing it would be a real loss and no
        // gain — and this asserts the override did not reach it.
        expect(cookies[DEFAULTS.session]).toBeUndefined();
        expect(cookies.sessionToken).toBeUndefined();
        expect(Object.keys(cookies).sort()).toEqual(['pkceCodeVerifier', 'state']);
    });
});

describe('the OAuth check cookies over plain http', () => {
    const cookies = optionsFor('http://localhost:3000');

    it('stays Lax locally, because None would require Secure', () => {
        // A `Secure` cookie is not sent over http at all, so `None` locally
        // would break the flow it fixes in production. Nothing is cross-site
        // on a local origin, so Lax is also correct there.
        for (const key of ['pkceCodeVerifier', 'state'] as const) {
            expect(cookies[key].options.sameSite).toBe('lax');
            expect(cookies[key].options.secure).toBe(false);
        }
    });

    it('drops the __Secure- prefix with it, so name and policy agree', () => {
        expect(cookies.pkceCodeVerifier.name).toBe(DEFAULTS.pkce);
        expect(cookies.state.name).toBe(DEFAULTS.state);
    });
});
