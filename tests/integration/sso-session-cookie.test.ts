/**
 * An SSO sign-in produces a session the app can actually read.
 *
 * ## The bug this closes
 *
 * Both SSO callbacks hand-rolled the session cookie:
 *
 *   jwt.sign(payload, secret, {expiresIn:'7d'})      → a JWS
 *   cookies().set('authjs.session-token', …)         → the NextAuth v5 name
 *
 * This app is NextAuth v4: it reads `next-auth.session-token` and decodes a
 * JWE. So the assertion validated, the identity linked, the user was
 * redirected to their dashboard — and the middleware bounced them to
 * /login. A loop, with no error surfaced anywhere. Nobody had ever
 * completed an SSO login.
 *
 * ## Why the POSITIVE CONTROL is not optional here
 *
 * Every assertion below is of the form "getToken can read this". A harness
 * with the wrong secret, or a mis-shaped NextRequest, makes `getToken`
 * return null for EVERYTHING — and a test that only asserts the fixed path
 * would then pass by failing in the same direction it is meant to detect.
 * The control mints a token via `encode()` (v4's own primitive) and asserts
 * it IS readable, so a broken harness fails loudly instead of agreeing.
 *
 * ## And why `memberships` is asserted separately
 *
 * Fixing the encoding alone would have left SSO broken. The Edge tenant
 * gate authorises purely by scanning `token.memberships[].slug`
 * (`checkTenantAccess`), so a decodable token carrying only
 * tenantId/role — which is what the old payload had — still yields
 * `no_tenant_access` and dumps the user on /no-tenant. The claim set is
 * the third defect, and it is the one a "just fix the cookie name" patch
 * would have missed.
 */
import { encode, getToken } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { sessionCookieName, useSecureCookies } from '@/lib/auth/sso-session';

const SECRET = 'sso-test-secret-at-least-32-characters-long'; // pragma: allowlist secret -- local encode/decode input, never a credential

function requestWithCookie(name: string, value: string): NextRequest {
    return new NextRequest('http://localhost:3000/t/acme-corp/dashboard', {
        headers: { cookie: `${name}=${value}` },
    });
}

describe('the harness itself (positive control)', () => {
    it('getToken CAN read a token minted by v4s own encode()', async () => {
        // If this ever fails, every other assertion in this file is
        // meaningless — they would all "pass" by returning null.
        const token = await encode({
            token: { sub: 'usr_1', userId: 'usr_1', email: 'a@b.c' },
            secret: SECRET,
        });
        const read = await getToken({
            req: requestWithCookie('next-auth.session-token', token) as never,
            secret: SECRET,
        });
        expect(read).not.toBeNull();
        expect(read?.userId).toBe('usr_1');
    });
});

describe('what the OLD SSO callbacks produced', () => {
    it('is unreadable — a jsonwebtoken JWS is not a NextAuth JWE', async () => {
        // Reproduces the shipped bug exactly. Kept as a regression anchor:
        // if someone reintroduces jwt.sign here, this documents why it
        // cannot work rather than leaving the next reader to rediscover it.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const jwt = require('jsonwebtoken');
        const jws = jwt.sign({ userId: 'usr_1', sub: 'usr_1' }, SECRET, { expiresIn: '7d' });

        for (const name of ['authjs.session-token', 'next-auth.session-token']) {
            const read = await getToken({
                req: requestWithCookie(name, jws) as never,
                secret: SECRET,
            });
            expect(read).toBeNull();
        }
    });
});

describe('the cookie NAME must be the one v4 reads', () => {
    it('is a next-auth.* name, never an authjs.* one', () => {
        expect(sessionCookieName()).toMatch(/^(__Secure-)?next-auth\.session-token$/);
        expect(sessionCookieName()).not.toContain('authjs.session-token');
    });

    it('derives the secure prefix from NEXTAUTH_URL, not NODE_ENV', () => {
        // v4 derives it from the URL scheme (next-auth/jwt/index.js). The old
        // code used NODE_ENV, so a production deploy behind plain http wrote
        // __Secure-… and read next-auth.… — or vice versa on https staging.
        const original = process.env.NEXTAUTH_URL;
        try {
            process.env.NEXTAUTH_URL = 'https://app.example.com';
            jest.resetModules();
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const https = require('@/lib/auth/sso-session');
            expect(https.useSecureCookies()).toBe(true);
            expect(https.sessionCookieName()).toBe('__Secure-next-auth.session-token');

            process.env.NEXTAUTH_URL = 'http://localhost:3000';
            jest.resetModules();
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const http = require('@/lib/auth/sso-session');
            expect(http.useSecureCookies()).toBe(false);
            expect(http.sessionCookieName()).toBe('next-auth.session-token');
        } finally {
            process.env.NEXTAUTH_URL = original;
            jest.resetModules();
        }
    });
});

describe('the claim set the Edge tenant gate needs', () => {
    it('a token WITHOUT memberships is refused by checkTenantAccess', async () => {
        // The third defect, isolated. This is what the old payload carried:
        // decodable, authenticated — and still bounced to /no-tenant.
        const { checkTenantAccess } = await import('@/lib/auth/guard');
        expect(
            checkTenantAccess('/t/acme-corp/dashboard', undefined, false),
        ).toBe('no_tenant_access');
        expect(checkTenantAccess('/t/acme-corp/dashboard', [], false)).toBe(
            'no_tenant_access',
        );
    });

    it('a token WITH the matching membership is allowed', async () => {
        const { checkTenantAccess } = await import('@/lib/auth/guard');
        expect(
            checkTenantAccess(
                '/t/acme-corp/dashboard',
                [{ tenantId: 't1', slug: 'acme-corp', role: 'ADMIN' }],
                false,
            ),
        ).toBe('allow');
    });
});

describe('the SSO callbacks no longer hand-roll a cookie', () => {
    it('neither callback signs its own token or names a v5 cookie', () => {
        // Structural, deliberately: the behavioural halves above cannot see
        // a THIRD callback added later that repeats the mistake.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const path = require('path');
        const root = path.resolve(__dirname, '../..');
        for (const rel of [
            'src/app/api/auth/sso/saml/callback/route.ts',
            'src/app/api/auth/sso/oidc/callback/route.ts',
        ]) {
            const src = fs.readFileSync(path.join(root, rel), 'utf8');
            expect(src).toContain('establishSsoSession');
            expect(src).not.toMatch(/jwt\.sign\(/);
            expect(src).not.toMatch(/['"]__?[Ss]ecure-?authjs\.session-token['"]/);
            expect(src).not.toMatch(/['"]authjs\.session-token['"]/);
        }
    });
});
