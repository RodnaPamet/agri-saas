/**
 * The `next` parameter cannot send a browser off-origin.
 *
 * `/t/:slug/auth/mfa` read `next` from the query string and did
 * `window.location.href = next` once a code was accepted, with no
 * validation. So `?next=https://attacker.example` redirected there in the
 * instant after somebody typed a correct second factor — the single most
 * convincing moment to show a "session expired, sign in again" page, because
 * the person has just proved to themselves that they are mid-authentication.
 *
 * Two separate defects, and the second is the wider one:
 *
 *   1. that page never called `sanitizeRedirectPath`, though it already
 *      existed and `buildLoginRedirect` and the consent page both used it;
 *   2. the sanitiser let `/\evil.example` through. `startsWith('//')` and
 *      `startsWith('\\')` both miss `/\`, and browsers normalise it to `//`
 *      — so EVERY caller was exposed, not just the page that prompted this.
 *
 * Found by agrent-ios reviewing #1649.
 */
import fs from 'node:fs';
import path from 'node:path';

import { sanitizeRedirectPath } from '@/lib/auth/safe-redirect';
import { blankNonCode } from '../helpers/blank-non-code';
import { REPO_ROOT } from '../helpers/collect-files';

const CHALLENGE = 'src/app/t/[tenantSlug]/(app)/auth/mfa/page.tsx';
const SETUP = 'src/app/t/[tenantSlug]/(app)/security/mfa/page.tsx';

const code = (rel: string): string =>
    blankNonCode(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));

describe('an off-origin `next` is refused (#1649)', () => {
    it.each([
        'https://attacker.example',
        'http://attacker.example/path',
        '//attacker.example',
        '/\\attacker.example',
        '/\\\\attacker.example',
        '\\\\attacker.example',
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        '%2F%2Fattacker.example',
        '%68ttps://attacker.example',
        'https:/\\attacker.example',
    ])('refuses %p', (input) => {
        expect(sanitizeRedirectPath(input)).toBe('/');
    });

    it.each([
        ['/api/auth/native/complete', '/api/auth/native/complete'],
        ['/t/my-farm/dashboard', '/t/my-farm/dashboard'],
        ['/t/my-farm/auth/mfa?next=%2Fapi%2Fauth%2Fnative%2Fcomplete', '/t/my-farm/auth/mfa?next=/api/auth/native/complete'],
    ])('still allows %p', (input, expected) => {
        // The phone's flow depends on this: `/api/auth/native/complete` is a
        // relative path, so the fix must not break the native handoff.
        expect(sanitizeRedirectPath(input)).toBe(expected);
    });

    it('`/\\` specifically — the gap that was open through every caller', () => {
        // Called out because the original rejected `//` and `\` and read as
        // though it covered this. A browser resolves `/\host` as `//host`.
        expect(sanitizeRedirectPath('/\\attacker.example')).toBe('/');
    });

    it('the challenge page SANITISES the value it navigates to', () => {
        const src = code(CHALLENGE);
        expect(src).toContain('sanitizeRedirectPath');
        // The raw parameter must not reach `location.href` directly.
        expect(src).not.toMatch(/const next = searchParams\.get\('next'\) \|\|/);
    });

    it('the setup page sanitises its resume target too', () => {
        // It can be opened directly, so it cannot rely on the challenge page
        // having cleaned the value.
        expect(code(SETUP)).toContain('sanitizeRedirectPath');
    });

    it('control: the checks DETECT the unsanitised shape', () => {
        // Teeth. Without this, the two assertions above pass on any file that
        // merely mentions the function somewhere.
        const original = "const next = searchParams.get('next') || tenantHref('/dashboard');";
        expect(original).toMatch(/const next = searchParams\.get\('next'\) \|\|/);
        expect(original).not.toContain('sanitizeRedirectPath');
    });
});
