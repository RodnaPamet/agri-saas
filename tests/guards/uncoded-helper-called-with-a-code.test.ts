/**
 * Guard: an UNCODED error helper is never called with a CODE as its message
 * (#1645).
 *
 * ## The shape
 *
 * `forbidden`, `badRequest` and their siblings take a **message**:
 *
 * ```ts
 * export const forbidden = (message: string = 'Forbidden') =>
 *     new ForbiddenError(message);
 * ```
 *
 * So `forbidden('MFA_REQUIRED')` puts the code in `error.message` and leaves
 * `error.code` at whatever default the subclass assigns. The response then
 * carries the right token in the wrong field, which fails in both directions at
 * once: a client branching on `error.code` has nothing to branch on, and a
 * client rendering `error.message` shows a farmer the literal string
 * `MFA_REQUIRED`.
 *
 * `codedForbidden(code, message)` is the shape that gets both — the code is the
 * contract, the message is the English fallback for a code the client has never
 * heard of.
 *
 * **There is no coded sibling for 401.** `UnauthorizedError`'s constructor takes
 * a message and hard-codes `'UNAUTHORIZED'`, so `unauthorized` is derived into
 * the population below with nothing to migrate a violation TO. That is reported
 * rather than papered over: a code worth sending on a 401 needs
 * `UnauthorizedError` to accept one first, which is a change to
 * `src/lib/errors/types.ts` and not something a call site can route around.
 *
 * ## Why a guard, when the fix was five lines
 *
 * Because the class has now been found twice, from opposite directions, and
 * neither existing check can see it.
 *
 * The first time, twenty-five call sites across five usecases were written
 * `badRequest('INVALID_CROP_TYPE', 'Crop type not found…')` against a
 * `(message, details)` signature — the docblock above `codedBadRequest` records
 * it, and records that an operator on the phone read
 * `"message":"INVALID_CROP_TYPE"`. The `coded*()` helpers exist precisely so
 * that the argument order people were already writing means what it looks like.
 *
 * The second time was these five, which that migration missed:
 *
 * ```
 * context.ts                 forbidden('API_KEY_NOT_PERSON_SCOPED')
 * context.ts                 forbidden('MFA_REQUIRED')
 * context.ts                 forbidden('OPERATOR_SCOPE')
 * usecases/farm-profile.ts   badRequest('FARM_PROFILE_EIK_NOT_EDITABLE')
 * ai/budget.ts               forbidden('AI_BUDGET_REQUIRES_VERIFIED_FARM')
 * ```
 *
 * Each sat under a comment arguing, correctly, that a code beats untranslatable
 * English prose — and then reached for the helper that makes the code BE the
 * prose. Being deliberate about the code is what made the mistake invisible.
 *
 * **And the five were invisible to every code-aware check**, which is the real
 * cost. `tests/contracts/error-codes-are-documented.test.ts` derives its
 * population from the `coded*()` helpers and the two coded error classes, so a
 * code emitted through `forbidden` is not collected, is not on that test's
 * undocumented baseline, and is not required to be in the spec. The same
 * blindness as #1636, from the other side: #1636 widened which helpers are
 * COLLECTED, and this is the uncoded helpers being called as though they were
 * coded ones.
 *
 * ## The population is DERIVED from the helper definitions
 *
 * The uncoded helper names come from parsing `src/lib/errors/types.ts`, not
 * from a list here. Thirteen take a bare `message` today; a fourteenth added
 * tomorrow is in scope the moment it exists, which is the point —
 * `population-follows-the-type` is the lesson, and a hand-maintained list of
 * helper names is the thing that goes stale.
 *
 * ## Comments are blanked, and that is load-bearing here
 *
 * `blankNonCode` first, because the fix for #1645 deliberately left SCARS: each
 * converted call site carries a comment quoting the old
 * `forbidden('AI_BUDGET_REQUIRES_VERIFIED_FARM')` form to explain what was
 * wrong with it, and `src/lib/errors/types.ts` quotes the `INVALID_CROP_TYPE`
 * shape in the docblock above the coded helpers. Without blanking, this guard
 * would report every explanation of the defect as an instance of it — `a-scar-
 * is-not-a-wound`, and the thing that makes a guard about a fixed class
 * unfixable.
 *
 * ## The allowlist is empty, so the mutation proof is the teeth
 *
 * Zero live violations, so a green run here proves nothing on its own: an
 * assertion over an empty selection passes for free. Hence the detector is run
 * against synthetic sources in both directions, the way
 * `social-routes-flag-gated` does for a population that is zero until P2 — and
 * hence the DENOMINATOR is printed, because "no violations" and "the scan
 * selected nothing" are the same observation otherwise.
 */
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

/**
 * A helper that takes a MESSAGE and no code, read from its own definition.
 *
 * `export const forbidden = (message: string = 'Forbidden') =>` — the `coded*`
 * family is excluded by name, because its first parameter IS the code.
 *
 * Thirteen qualify today, and `staleData` is the one worth naming: it carries a
 * FIXED code (`'STALE_DATA'`, assigned inside the helper) and still takes a
 * message first, so `staleData('SOME_CODE')` is the same defect with the extra
 * twist that `error.code` would be confidently wrong rather than generic. It is
 * derived in rather than reasoned about, which is the argument for deriving.
 */
const HELPER_DEF = /^export const ([a-z][A-Za-z0-9]*) = \(\s*message\b/gm;

function uncodedHelpers(): string[] {
    const src = readFileSync(`${REPO_ROOT}/src/lib/errors/types.ts`, 'utf8');
    const names = [...src.matchAll(HELPER_DEF)]
        .map((m) => m[1])
        .filter((n) => !n.startsWith('coded'));
    return [...new Set(names)].sort();
}

/**
 * A code-shaped literal as the WHOLE first argument.
 *
 * The closing quote is part of the pattern, deliberately: anchoring only the
 * opening one matches `'MFA verification required.'` — three leading capitals
 * and then prose — so every correctly-converted call site in the same diff
 * would have been reported as a violation.
 */
function violationPattern(helpers: readonly string[]): RegExp {
    return new RegExp(
        String.raw`\b(${helpers.join('|')})\(\s*(['"])([A-Z][A-Z0-9_]{2,})\2`,
        'g',
    );
}

/** Any call to one of the helpers, code-shaped argument or not. */
function callPattern(helpers: readonly string[]): RegExp {
    return new RegExp(String.raw`\b(${helpers.join('|')})\(`, 'g');
}

interface Hit {
    file: string;
    line: number;
    helper: string;
    code: string;
}

/**
 * A violation that is deliberate, keyed `path:CODE`, each with a written
 * reason.
 *
 * EMPTY, and an entry is a decision to ship a code in the message field — so
 * the reason has to say which client reads it there and why moving it would
 * break that client. "It is only one call site" is not one.
 */
const ALLOWLIST: Readonly<Record<string, string>> = {};

describe('an uncoded error helper is never called with a code (#1645)', () => {
    const helpers = uncodedHelpers();
    const files = collectSourceFiles({
        roots: ['src'],
        extensions: ['.ts', '.tsx'],
        exclude: (rel) => rel.startsWith('src/generated/'),
        // ~2100 today. A floor near reality catches an exclude predicate that
        // ate the tree rather than reporting it clean.
        floor: 1500,
    });

    const hits: Hit[] = [];
    let calls = 0;

    for (const abs of files) {
        const rel = relative(REPO_ROOT, abs);
        const code = blankNonCode(readFileSync(abs, 'utf8'));
        calls += [...code.matchAll(callPattern(helpers))].length;

        for (const m of code.matchAll(violationPattern(helpers))) {
            const line = code.slice(0, m.index).split('\n').length;
            hits.push({ file: rel, line, helper: m[1], code: m[3] });
        }
    }

    it('names the helpers it derived, and the population it scanned', () => {
        // The denominator, printed unconditionally. A detector that stopped
        // matching reports zero violations and looks exactly like a clean
        // tree; these two numbers are what tell them apart.
        console.log(
            `[uncoded-helper-called-with-a-code] ${helpers.length} uncoded helpers ` +
                `(${helpers.join(', ')}); ${calls} call(s) across ${files.length} files; ` +
                `${hits.length} violation(s).`,
        );
        expect(helpers).toContain('forbidden');
        expect(helpers).toContain('badRequest');
        expect(helpers.length).toBeGreaterThanOrEqual(5);
        expect(calls).toBeGreaterThan(50);
    });

    it('has no uncoded helper carrying a code as its message', () => {
        const unexcused = hits.filter((h) => !(`${h.file}:${h.code}` in ALLOWLIST));
        if (unexcused.length > 0) {
            const list = unexcused
                .map((h) => `  ${h.file}:${h.line}  ${h.helper}('${h.code}')`)
                .join('\n');
            throw new Error(
                `${unexcused.length} refusal(s) pass a CODE where the helper wants a ` +
                    `MESSAGE:\n\n${list}\n\n` +
                    `The code lands in error.message and error.code stays generic, so a ` +
                    `client has nothing to branch on and a farmer can be shown the ` +
                    `token. Use coded${''}Forbidden(code, message) — or its sibling for ` +
                    `the status you want — and add the code to the undocumented ` +
                    `baseline in tests/contracts/error-codes-are-documented.test.ts if ` +
                    `the spec does not name it yet.\n\n` +
                    `If the helper is \`unauthorized\`, there is no coded sibling: ` +
                    `UnauthorizedError hard-codes 'UNAUTHORIZED'. Give it a code ` +
                    `parameter the way ForbiddenError has one, or answer 403.`,
            );
        }
        expect(unexcused).toEqual([]);
    });

    it('carries a written reason for every allowlisted violation', () => {
        for (const [key, reason] of Object.entries(ALLOWLIST)) {
            expect(reason.trim().length).toBeGreaterThan(40);
            expect(key).toMatch(/^src\/.+:[A-Z][A-Z0-9_]{2,}$/);
        }
    });

    it('has no stale allowlist entry', () => {
        const live = new Set(hits.map((h) => `${h.file}:${h.code}`));
        for (const key of Object.keys(ALLOWLIST)) {
            expect(live.has(key)).toBe(true);
        }
    });

    // ── The teeth ────────────────────────────────────────────────────────
    //
    // The live population is zero, so every assertion above passes over an
    // empty set. These run the detector against sources written to be found
    // and sources written not to be, which is the only available proof that
    // it can still tell them apart.
    describe('the detector, against synthetic sources', () => {
        const scan = (src: string): Hit[] => {
            const out: Hit[] = [];
            const code = blankNonCode(src);
            for (const m of code.matchAll(violationPattern(helpers))) {
                out.push({ file: 'synthetic.ts', line: 0, helper: m[1], code: m[3] });
            }
            return out;
        };

        it('finds the shape #1645 was about', () => {
            expect(scan(`throw forbidden('MFA_REQUIRED');`)).toHaveLength(1);
            expect(scan(`throw badRequest('FARM_PROFILE_EIK_NOT_EDITABLE');`)).toHaveLength(
                1,
            );
            expect(scan(`throw notFound("PARCEL_NOT_FOUND");`)).toHaveLength(1);
        });

        it('finds it across every derived helper, not just the two that were hit', () => {
            for (const helper of helpers) {
                expect(scan(`throw ${helper}('SOME_CODE');`)).toHaveLength(1);
            }
        });

        it('leaves a correctly coded throw alone', () => {
            expect(
                scan(`throw codedForbidden('MFA_REQUIRED', 'MFA verification required.');`),
            ).toEqual([]);
            expect(
                scan(`throw codedBadRequest('X_Y_Z', 'A sentence.', { count: 1 });`),
            ).toEqual([]);
        });

        it('leaves a prose message alone, including one that OPENS in capitals', () => {
            // The regression this protects against is the pattern anchoring
            // only its opening quote: `MFA verification required.` starts with
            // three capitals, so a half-anchored pattern reports every call
            // site the #1645 fix created.
            expect(scan(`throw forbidden('MFA verification required.');`)).toEqual([]);
            expect(scan(`throw forbidden('Permission denied');`)).toEqual([]);
            expect(scan(`throw unauthorized('Unauthorized');`)).toEqual([]);
            expect(scan(`throw badRequest('EIK must be nine digits.');`)).toEqual([]);
        });

        it('leaves a COMMENT quoting the bad shape alone', () => {
            // The #1645 fix left these scars on purpose, at four call sites and
            // in types.ts. Reporting an explanation of the defect as the defect
            // is how a guard about a fixed class becomes unfixable.
            expect(scan(`// This read forbidden('MFA_REQUIRED') until #1645.`)).toEqual([]);
            expect(
                scan(`/**\n * badRequest('INVALID_CROP_TYPE', 'Crop type not found…')\n */`),
            ).toEqual([]);
        });

        it('leaves the helper DEFINITIONS alone', () => {
            // `export const forbidden = (message: string = 'Forbidden') =>` is
            // the default argument, not a call.
            expect(
                scan(`export const forbidden = (message: string = 'Forbidden') =>`),
            ).toEqual([]);
            expect(
                scan(`export const notFound = (message: string = 'Not Found') =>`),
            ).toEqual([]);
        });
    });
});
