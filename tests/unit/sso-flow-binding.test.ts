/**
 * #3205 — a tenant SSO flow is bound to the browser that started it, the
 * value sent through the IdP carries nothing, and `returnTo` cannot leave the
 * origin. These EXECUTE the binding; the route wiring is covered below by
 * reading the four routes, with a positive control.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
    openSsoFlow,
    safeReturnTo,
    sealSsoFlow,
    ssoFlowCookieOptions,
    SSO_FLOW_TTL_SECONDS,
} from '@/lib/security/sso-flow-binding';
import { blankNonCode } from '../helpers/blank-non-code';

const NOW = 1_800_000_000;
const payload = { tenantSlug: 'acme', providerId: 'p1', codeVerifier: 'v', nonce: 'n', returnTo: '/t/acme/journal' };

describe('sealSsoFlow / openSsoFlow', () => {
    it('opens a flow in the browser that started it', () => {
        const { state, cookie } = sealSsoFlow(payload, NOW);
        expect(openSsoFlow(cookie, state, NOW + 1)).toEqual(payload);
    });

    it('login CSRF: a callback replayed in another browser (no cookie) is refused', () => {
        const { state } = sealSsoFlow(payload, NOW);
        expect(openSsoFlow(undefined, state, NOW)).toBeNull();
    });

    it("login CSRF: the attacker's state with the victim's own (different) flow cookie is refused", () => {
        const attacker = sealSsoFlow(payload, NOW);
        const victim = sealSsoFlow(payload, NOW);
        expect(openSsoFlow(victim.cookie, attacker.state, NOW)).toBeNull();
    });

    it('a tampered cookie is refused', () => {
        const { state, cookie } = sealSsoFlow(payload, NOW);
        const [body, tag] = cookie.split('.');
        const forged = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        forged.p.tenantSlug = 'victim';
        const forgedBody = Buffer.from(JSON.stringify(forged)).toString('base64url');
        expect(openSsoFlow(`${forgedBody}.${tag}`, state, NOW)).toBeNull();
    });

    it('an expired flow is refused', () => {
        const { state, cookie } = sealSsoFlow(payload, NOW);
        expect(openSsoFlow(cookie, state, NOW + SSO_FLOW_TTL_SECONDS + 1)).toBeNull();
        // Control: just inside the window it opens.
        expect(openSsoFlow(cookie, state, NOW + SSO_FLOW_TTL_SECONDS)).not.toBeNull();
    });

    it('the token sent through the IdP carries no payload — PKCE verifier included', () => {
        const { state } = sealSsoFlow({ ...payload, codeVerifier: 'very-secret-verifier' }, NOW);
        const decoded = Buffer.from(state, 'base64url').toString('latin1');
        expect(decoded).not.toContain('very-secret-verifier');
        expect(state).not.toContain('acme');
        expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
});

describe('safeReturnTo', () => {
    it.each([
        ['/t/acme/dashboard', '/t/acme/dashboard'],
        ['/t/acme/journal?x=1#y', '/t/acme/journal?x=1#y'],
    ])('keeps the same-origin path %s', (raw, want) => {
        expect(safeReturnTo(raw)).toBe(want);
    });

    it.each([
        '//evil.example',
        '//evil.example/path',
        '/\\evil.example',
        'https://evil.example',
        'javascript:alert(1)',
        'evil.example',
        '/t/x\nLocation: //evil.example',
        '',
        null,
        undefined,
    ])('refuses %p', (raw) => {
        expect(safeReturnTo(raw as string | null | undefined)).toBeNull();
    });
});

describe('cookie attributes', () => {
    it('SAML (cross-site POST) needs SameSite=None, which requires Secure', () => {
        expect(ssoFlowCookieOptions({ crossSitePost: true, secure: true }).sameSite).toBe('none');
        expect(ssoFlowCookieOptions({ crossSitePost: true, secure: false }).sameSite).toBe('lax');
        expect(ssoFlowCookieOptions({ crossSitePost: false, secure: true }).sameSite).toBe('lax');
        expect(ssoFlowCookieOptions({ crossSitePost: false, secure: true }).httpOnly).toBe(true);
    });
});

describe('route wiring', () => {
    const read = (rel: string) => blankNonCode(readFileSync(join(__dirname, '../..', rel), 'utf8'));

    it.each(['oidc', 'saml'])('%s start seals the flow and sets the cookie; callback opens it and clears it', (kind) => {
        const start = read(`src/app/api/auth/sso/${kind}/start/route.ts`);
        const callback = read(`src/app/api/auth/sso/${kind}/callback/route.ts`);
        expect(start).toContain('sealSsoFlow(');
        expect(start).toContain('response.cookies.set(');
        expect(start).toContain('safeReturnTo(');
        expect(callback).toContain('openSsoFlow');
        expect(callback).toContain('SSO_FLOW_COOKIE_CLEAR');
        expect(callback).toContain('safeReturnTo(');
        // The unsigned encoders are gone.
        expect(start + callback).not.toMatch(/encodeState|decodeState|SamlRelayState\(/);
    });
});
