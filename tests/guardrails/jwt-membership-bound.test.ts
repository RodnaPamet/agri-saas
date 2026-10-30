/**
 * Guardrail — the JWT membership payload stays bounded.
 *
 * The NextAuth JWT is a fixed-size credential carried in a cookie, not
 * a data store. The `jwt` callback in `src/auth.ts` embeds the user's
 * tenant + org memberships so the Edge middleware can authorize a slug
 * with no DB hit — but a user in very many tenants would otherwise
 * grow the cookie without bound (a latent overflow bug).
 *
 * The fix (2026-05-21): both membership arrays are capped at
 * `MAX_JWT_MEMBERSHIPS` and the over-cap case is flagged with
 * `membershipsTruncated` / `orgMembershipsTruncated` so the middleware
 * gate can defer a slug-miss to the authoritative server-side check.
 *
 * This ratchet fails CI if a future edit:
 *   - removes the `.slice(0, MAX_JWT_MEMBERSHIPS)` cap from either
 *     array (re-introducing the unbounded payload), or
 *   - bumps `MAX_JWT_MEMBERSHIPS` past a sane ceiling (defeating the
 *     bound by making the "cap" effectively infinite), or
 *   - drops the truncation flags the middleware relies on.
 *
 * The checks scan the raw source: every pattern asserted here
 * (`export const MAX_JWT_MEMBERSHIPS = <n>`, `.slice(0, …)`) is
 * executable-code syntax that never appears in prose, so no
 * comment-stripping is needed.
 */
import * as fs from 'fs';
import * as path from 'path';

import { blankNonCode } from '../helpers/blank-non-code';

const AUTH_TS = path.resolve(__dirname, '../../src/auth.ts');

/** src/auth.ts is ~67 KB. A truncated read must fail, not quietly satisfy a check. */
const AUTH_MIN_BYTES = 20_000;

const SLICE_RE = /\.slice\(\s*0\s*,\s*MAX_JWT_MEMBERSHIPS\s*\)/g;

/**
 * Generous ceiling. The cap exists to bound the cookie; even 200 fat
 * entries is "bounded", but anything past this is a conscious decision
 * that must edit this guardrail (and explain why) in the same PR.
 */
const MAX_REASONABLE_CAP = 200;

/**
 * The source under audit, with COMMENTS BLANKED — and a NAMED selector, so
 * `scripts/selector-teeth` can reach this guard at all (#2483; it was one of
 * the four security/safety guards that reach reading watches).
 *
 * The docblock above argued stripping was unnecessary because every asserted
 * pattern is executable syntax that never appears in prose. That is true of
 * the two patterns it ENUMERATES — `export const MAX_JWT_MEMBERSHIPS` and
 * `.slice(0, …)`, both raw=code — and FALSE of the one it omits. Measured
 * 2026-10-30: `membershipsTruncated` occurs 10 times in src/auth.ts and only 6
 * of those are code. Four are prose.
 *
 * The consequence was proved, not argued. With the flags deleted from the code
 * and only the explaining comment left behind, this guard passed 4 of 4 —
 * reporting the control the middleware gate relies on as PRESENT when it was
 * gone. A scar read as a wound's absence.
 */
export function readAuthSource(): string {
    const raw = fs.readFileSync(AUTH_TS, 'utf-8');
    if (raw.length < AUTH_MIN_BYTES) {
        throw new Error(
            `src/auth.ts read as ${raw.length} bytes, under ${AUTH_MIN_BYTES} — `
                + 'refusing to audit a truncated read.',
        );
    }
    return blankNonCode(raw);
}

export function countMembershipCaps(code: string): number {
    return (code.match(new RegExp(SLICE_RE.source, 'g')) ?? []).length;
}

describe('JWT membership payload is bounded', () => {
    const code = readAuthSource();

    test('MAX_JWT_MEMBERSHIPS is defined and within a sane ceiling', () => {
        const m = /export const MAX_JWT_MEMBERSHIPS\s*=\s*(\d+)/.exec(code);
        expect(m).not.toBeNull();
        const cap = Number(m![1]);
        expect(cap).toBeGreaterThan(0);
        expect(cap).toBeLessThanOrEqual(MAX_REASONABLE_CAP);
    });

    test('both membership arrays are capped with .slice(0, MAX_JWT_MEMBERSHIPS)', () => {
        // One for tenant memberships, one for org memberships.
        expect(countMembershipCaps(code)).toBeGreaterThanOrEqual(2);
    });

    test('the truncation flags the middleware gate relies on are present', () => {
        expect(code).toContain('membershipsTruncated');
        expect(code).toContain('orgMembershipsTruncated');
    });

    // ─── Regression proof — the detector catches an un-capped payload ───

    test('detector flags an auth.ts that maps memberships without the cap', () => {
        // THE CONTROL, which this test did not have. It read:
        //
        //     const mutated = code.replace(SLICE_RE, '');
        //     expect((mutated.match(SLICE_RE) ?? []).length).toBe(0);
        //
        // A regex that matches NOTHING leaves the string unchanged and `match`
        // returns null, so that assertion passed whether or not `SLICE_RE` had
        // ever matched. It asserted that `String.replace` works — zero
        // discriminating power about the cap it is named for.
        const before = countMembershipCaps(code);
        expect(before).toBeGreaterThanOrEqual(2);
        expect(countMembershipCaps(code.replace(SLICE_RE, ''))).toBe(0);
    });
});
