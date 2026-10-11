/**
 * Every session-mint path says how it knows the second factor is satisfied.
 *
 * `buildSessionClaims` is the single producer of session claims, and it was
 * missing `mfaPending` entirely. Both gates that read that claim test
 * `=== true`, so an ABSENT claim passed both — and every caller of this
 * function minted a credential that skipped the farm's second factor. Six
 * call sites, across the native exchange, the webview adopt, the Apple
 * route, every token refresh, and BOTH SSO callbacks. The web asked a
 * password user for a code; none of these did.
 *
 * The fix makes the question unanswerable by omission: `mfa` is a required
 * parameter with no default, so a new mint path cannot inherit the unsafe
 * behaviour by not thinking about it. This guard is the other half — it
 * checks the parameter is still required, and that every call site is
 * accounted for rather than quietly multiplying.
 *
 * Why a scan and not just the type: a required parameter stops a caller
 * omitting it, but nothing stops someone adding `mfa: 'inherit-satisfied'`
 * to a path that inherits nothing. The count below is what makes a seventh
 * call site a conversation rather than a silent default.
 */
import fs from 'node:fs';
import path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

/**
 * Every call site, and the proof each one relies on.
 *
 * `inherit-satisfied` is only honest when the caller REQUIRES a credential
 * that could not exist unless the factor was presented. Spelled out per
 * site, because "it inherits" is the claim that needs checking when one of
 * these is edited.
 */
const EXPECTED: Record<string, 'inherit-satisfied' | 'evaluate'> = {
    // Holds an auth code, issued by `native/complete` only once the cookie
    // session's `mfaPending` is false.
    'src/app/api/auth/native/exchange/route.ts': 'inherit-satisfied',
    // Holds a native bearer, which only `/exchange` mints from such a code.
    'src/app/api/auth/native/adopt/route.ts': 'inherit-satisfied',
    // Holds a refresh token, issued alongside a session that cleared the gate.
    // Re-evaluating here would be a permanent re-challenge, not a gate.
    'src/app/api/auth/token/refresh/route.ts': 'inherit-satisfied',
    // Refuses with MFA_REQUIRED before reaching the mint when a factor is owed.
    'src/app/api/auth/native/apple/route.ts': 'inherit-satisfied',
    // A FRESH sign-in: SAML/OIDC callbacks never pass through the `jwt`
    // callback, so nothing upstream has considered MFA.
    'src/lib/auth/sso-session.ts': 'evaluate',
    // The ONE caller that earns `inherit-satisfied` in the request itself
    // rather than inheriting it from a credential issued earlier: the factor
    // was just presented and verified, two statements above the mint. Apple
    // sign-in has no browser sheet, so this is where the code is collected.
    'src/app/api/auth/native/mfa/route.ts': 'inherit-satisfied',
};

const read = (rel: string): string =>
    blankNonCode(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));

describe('every session mint states its MFA source', () => {
    it('`mfa` is still a REQUIRED parameter of buildSessionClaims', () => {
        const src = read('src/auth.ts');
        const sig = src.match(/export async function buildSessionClaims\(input: \{[\s\S]{0,600}?\}\)/);
        expect(sig).toBeTruthy();
        // `mfa:` and not `mfa?:`. An optional parameter would restore exactly
        // the failure this fixed: a new caller omits it and gets the lenient
        // answer with nothing to notice.
        expect(sig![0]).toMatch(/\bmfa:\s*MfaClaimSource/);
        expect(sig![0]).not.toMatch(/\bmfa\?:/);
    });

    it('the claim is written, never left absent', () => {
        // Absence is what hid this: a `=== true` gate cannot distinguish "no
        // factor owed" from "nobody asked".
        expect(read('src/auth.ts')).toMatch(/mfaPending:\s*false/);
    });

    it.each(Object.entries(EXPECTED))('%s declares %s', (rel, expected) => {
        const src = read(rel);
        expect(src).toContain('buildSessionClaims(');
        expect(src).toContain(`mfa: '${expected}'`);
    });

    it('no UNACCOUNTED call site has appeared', () => {
        // The teeth. A seventh mint path should fail here and be argued about,
        // not default into whichever literal its author copied.
        const files = collectSourceFiles({ roots: ['src'], extensions: ['.ts'], floor: 500 });
        const callers = files
            .filter((f) => /buildSessionClaims\(/.test(blankNonCode(fs.readFileSync(f, 'utf8'))))
            .map((f) => path.relative(REPO_ROOT, f))
            // `auth.ts` DEFINES it.
            .filter((rel) => rel !== 'src/auth.ts')
            .sort();
        expect(callers).toEqual(Object.keys(EXPECTED).sort());
    });

    it('the Apple route refuses BEFORE it writes a session row', () => {
        // Order, not presence. The first version of this gate sat inside the
        // route's `buildClaims`, which runs AFTER `recordNewSession` — so a
        // refused sign-in still created a `UserSession` row for a session
        // never issued. `recordNewSession` enforces `maxConcurrentSessions`,
        // so on a farm with that limit set, repeated refused attempts would
        // evict the person's real sessions: a refusal that costs the user
        // their other sessions is worse than the gate it enforces.
        //
        // A test asserting only that the refusal EXISTS passes either way,
        // which is why this one is about position.
        const src = read('src/app/api/auth/native/apple/route.ts');
        const gate = src.indexOf('await assertMfaNotOwed(');
        const write = src.indexOf('recordNewSession({');
        expect(gate).toBeGreaterThan(-1);
        expect(write).toBeGreaterThan(-1);
        expect(gate).toBeLessThan(write);
    });

    it('control: the scan FINDS a caller, so an empty result cannot pass', () => {
        const files = collectSourceFiles({ roots: ['src'], extensions: ['.ts'], floor: 500 });
        expect(files.length).toBeGreaterThan(500);
        const hits = files.filter((f) =>
            /buildSessionClaims\(/.test(blankNonCode(fs.readFileSync(f, 'utf8'))),
        );
        // Six: the five callers plus the definition.
        expect(hits.length).toBeGreaterThanOrEqual(6);
    });
});
