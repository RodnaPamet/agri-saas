/**
 * `REFERENCED_FLAG_KEYS` names every key the code gates on — #2009, #2291.
 *
 * ## The defect this is the in-repo half of
 *
 * A missing `FeatureFlag` row is OFF by design, so a gated surface whose key
 * was never inserted is unreachable while looking implemented. #2009's
 * instance 3: `social.public-profile` gated 12 call sites, production held one
 * row, every surface 404'd for months. Comparing the two sides needs
 * production, so the comparison is not a unit test — but the POPULATION is,
 * and a population that silently covers four of six keys is the failure one
 * level up.
 *
 * ## Why the obvious extraction is not enough, measured
 *
 * #2009 proposes a grep for a quoted first argument. Measured 2026-10-24 it
 * finds four of the six keys: five call sites pass a CONSTANT, and two keys
 * exist ONLY behind one — `integrations.google` (which had no production row)
 * and `notifications.sse`, the flag that replaced
 * `NEXT_PUBLIC_NOTIFICATIONS_SSE`, i.e. instance 2 itself. So this resolves
 * single-level constants, and the first control below is a constant-passed key.
 *
 * ## An unresolvable key FAILS rather than being dropped
 *
 * That is the assertion that makes the list worth comparing against. A key
 * assembled at runtime — `FLAGS[surface]`, a template literal — cannot be
 * enumerated by anything, so it cannot be checked for a row and an operator
 * cannot find it by reading the route. `social-routes-flag-gated` already
 * requires a literal for the social roots and its own mutation proof found the
 * interpolated-template hole there; this covers the rest of `src/`, where
 * constants are the house style and a literal is not required.
 *
 * ## Relationship to `social-routes-flag-gated`
 *
 * That guard asks whether a social route IS gated. This asks whether every
 * gate's key is ENUMERABLE and listed. Neither subsumes the other: a social
 * route gating on a computed key fails there; a non-social route gating on an
 * unlisted key fails only here. Same argument as
 * `public-routes-self-authenticate` vs
 * `public-route-exemptions-are-edge-reachable` — either half alone is worse
 * than neither.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { FLAG_KEY_PATTERN, FLAG_KEY_MAX_LENGTH } from '../../src/lib/feature-flags';
import { REFERENCED_FLAG_KEYS } from '../../src/lib/feature-flag-keys';
import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles } from '../helpers/collect-files';

const ROOT = path.resolve(__dirname, '../..');

const GATE_CALLEES = ['assertFeatureEnabled', 'isFeatureEnabled'] as const;

/**
 * The module that DECLARES the gates, excluded from the call-site population.
 *
 * `isFeatureEnabled(key, userId)` inside `assertFeatureEnabled` forwards its
 * own parameter, so its first argument is an identifier that resolves to no
 * literal — correctly, and reporting it would be noise that invites an
 * exemption list. Excluded by exact path, and the test below asserts this file
 * really is where the functions are declared, so a move fails loudly instead
 * of silently exempting whatever lands at the path next.
 */
const DECLARING_MODULE = 'src/lib/feature-flags.ts';

/**
 * First argument of each gate call, as source text.
 *
 * Deliberately NOT a quoted-literal pattern: the point is to see every call
 * site, including the ones a literal-only matcher cannot resolve, so that an
 * unresolvable one can FAIL rather than vanish. `[^,)]+` stops at the comma
 * before `userId`, which every call site has.
 */
const CALL = new RegExp(`\\b(${GATE_CALLEES.join('|')})\\s*\\(\\s*([^,)]+)`, 'g');

/** `const NAME = 'value'` / `NAME = "value"`, anywhere in the scanned code. */
const CONST_DECL = /\b([A-Z][A-Z0-9_]*)\s*(?::\s*[A-Za-z<>[\]| ]+)?\s*=\s*['"]([^'"]+)['"]/g;

type Site = { file: string; callee: string; arg: string };

/** Code only — comments blanked, so prose naming a gate creates no call site. */
function codeOf(file: string): string {
    return blankNonCode(readFileSync(file, 'utf8'));
}

const FILES = collectSourceFiles({
    roots: ['src'],
    // 2,100+ files today. A floor well under that and far above zero: it
    // catches a walk that stopped resolving, not growth (#865).
    floor: 800,
});

/** Every `NAME = 'literal'` in `src/`, so a constant-passed key can resolve. */
const CONSTANTS = new Map<string, string>();
/** Every gate call site, with its first argument unparsed. */
const SITES: Site[] = [];

for (const file of FILES) {
    const rel = path.relative(ROOT, file);
    const code = codeOf(file);
    for (const m of code.matchAll(CONST_DECL)) {
        // First wins. A name bound twice to different literals would make the
        // resolution ambiguous; the duplicate check below reports that rather
        // than letting the last writer decide.
        if (!CONSTANTS.has(m[1])) CONSTANTS.set(m[1], m[2]);
    }
    if (rel === DECLARING_MODULE) continue;
    for (const m of code.matchAll(CALL)) {
        SITES.push({ file: rel, callee: m[1], arg: m[2].trim() });
    }
}

type Resolved =
    | { kind: 'literal'; key: string }
    | { kind: 'constant'; key: string; via: string }
    | { kind: 'unresolved' };

/** A literal, or an identifier bound to one. Anything else is unresolved. */
export function resolveKey(arg: string, constants: Map<string, string>): Resolved {
    const literal = /^['"]([^'"]*)['"]$/.exec(arg);
    if (literal) return { kind: 'literal', key: literal[1] };
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(arg)) {
        const key = constants.get(arg);
        if (key !== undefined) return { kind: 'constant', key, via: arg };
    }
    return { kind: 'unresolved' };
}

const RESOLVED = SITES.map((s) => ({ ...s, ...resolveKey(s.arg, CONSTANTS) }));
const UNRESOLVED = RESOLVED.filter((r) => r.kind === 'unresolved');
const DERIVED = [
    ...new Set(RESOLVED.flatMap((r) => (r.kind === 'unresolved' ? [] : [r.key]))),
].sort();

describe('every gated flag key is enumerable and listed (#2009)', () => {
    it('[flag-keys] ranges over a real population', () => {
        const viaConstant = RESOLVED.filter((r) => r.kind === 'constant').length;
        // eslint-disable-next-line no-console
        console.log(
            `[flag-keys] ${DERIVED.length} key(s) from ${SITES.length} call site(s) across `
                + `${FILES.length} file(s); ${RESOLVED.length - viaConstant - UNRESOLVED.length} `
                + `literal, ${viaConstant} via a constant, ${UNRESOLVED.length} unresolved`,
        );
        // Each floor separates zero from nonzero. The constant floor is the one
        // that matters: it is the half #2009's grep misses, so an extraction
        // that stopped resolving constants would otherwise just look tidier.
        expect(SITES.length).toBeGreaterThanOrEqual(6);
        expect(DERIVED.length).toBeGreaterThanOrEqual(4);
        expect(viaConstant).toBeGreaterThanOrEqual(3);
    });

    it('the declaring module really declares the gates', () => {
        // Without this the exclusion above is a path that exempts whatever
        // lands there next. `a-needle-loses-the-thread-at-a-rename`.
        const code = codeOf(path.join(ROOT, DECLARING_MODULE));
        for (const callee of GATE_CALLEES) {
            expect({ callee, declared: code.includes(`function ${callee}`) }).toEqual({
                callee,
                declared: true,
            });
        }
    });

    it('every gate call site resolves to a static key', () => {
        // The property. A key assembled at runtime cannot be enumerated, so it
        // cannot be checked for a production row and an operator cannot find
        // it by reading the route.
        expect(
            UNRESOLVED.map((r) => `${r.file}: ${r.callee}(${r.arg})`),
        ).toEqual([]);
    });

    it('REFERENCED_FLAG_KEYS matches the derived population exactly', () => {
        // BOTH directions. A missing entry is a key no production check will
        // ask about; a stale entry is a key the check will report as missing a
        // row for ever, which is how a check earns its way to being ignored.
        expect([...REFERENCED_FLAG_KEYS].sort()).toEqual(DERIVED);
    });

    it('every listed key is a key the console would accept', () => {
        // A route gated on a key the console refuses is permanently off and
        // reads as not-yet-built — the rule `social-routes-flag-gated` states.
        // Pattern imported, never restated.
        for (const key of REFERENCED_FLAG_KEYS) {
            expect({
                key,
                valid: FLAG_KEY_PATTERN.test(key) && key.length <= FLAG_KEY_MAX_LENGTH,
            }).toEqual({ key, valid: true });
        }
    });

    it('no constant name is bound to two different keys', () => {
        // The resolution takes the first binding, so an ambiguous name would
        // make the derived set depend on file order.
        const seen = new Map<string, Set<string>>();
        for (const file of FILES) {
            for (const m of codeOf(file).matchAll(CONST_DECL)) {
                if (!/_FLAG$|^FLAG_|FLAG_KEY/.test(m[1])) continue;
                seen.set(m[1], (seen.get(m[1]) ?? new Set()).add(m[2]));
            }
        }
        const ambiguous = [...seen].filter(([, v]) => v.size > 1).map(([k, v]) => `${k}: ${[...v].join(' | ')}`);
        expect(ambiguous).toEqual([]);
    });

    describe('controls', () => {
        const constants = new Map([['NOTIFICATIONS_SSE_FLAG', 'notifications.sse']]);

        it('CONTROL: a key passed as a CONSTANT resolves', () => {
            // The exact blind spot in #2009's grep, and the reason this guard
            // is not a one-line literal matcher.
            expect(resolveKey('NOTIFICATIONS_SSE_FLAG', constants)).toEqual({
                kind: 'constant',
                key: 'notifications.sse',
                via: 'NOTIFICATIONS_SSE_FLAG',
            });
        });

        it('CONTROL: a literal resolves, in either quote style', () => {
            expect(resolveKey("'social.farm-media'", constants)).toEqual({
                kind: 'literal',
                key: 'social.farm-media',
            });
            expect(resolveKey('"social.farm-media"', constants)).toEqual({
                kind: 'literal',
                key: 'social.farm-media',
            });
        });

        it.each([
            ['a member expression', 'FLAGS.profiles'],
            ['an index expression', 'FLAGS[surface]'],
            ['a template literal', '`social.${surface}`'],
            ['a call', 'flagFor(surface)'],
            ['an unbound identifier', 'SOME_UNKNOWN_FLAG'],
        ])('CONTROL: %s is UNRESOLVED, not silently dropped', (_label, arg) => {
            // Each of these would otherwise contribute nothing to the
            // population while the call site is really there — a key no
            // production check can ask about. The template case is the one
            // `social-routes-flag-gated`'s mutation proof found: it contains no
            // quote character, so a naive literal matcher reads it as static.
            expect(resolveKey(arg, constants).kind).toBe('unresolved');
        });

        it('CONTROL: an empty literal does not become a key', () => {
            // `''` passes a "quoted" test and names no flag.
            const r = resolveKey("''", constants);
            expect(r).toEqual({ kind: 'literal', key: '' });
            // And it would fail the console's pattern, which is what the
            // listed-key test above would catch.
            expect(FLAG_KEY_PATTERN.test('')).toBe(false);
        });

        it('CONTROL: a gate named only in prose creates no call site', () => {
            // `a-scar-is-not-a-wound`. `src/` carries docblocks naming gates in
            // prose — one at `admin/integrations/google/connect/route.ts`
            // reads "Gated by `admin.manage` and by the `integrations.google`
            // runtime flag" — and a text-matching population would invent call
            // sites from them.
            const source = [
                "// await assertFeatureEnabled('social.commented-out', userId);",
                "/* assertFeatureEnabled('social.blocked', userId) */",
                "await assertFeatureEnabled('social.real', userId);",
            ].join('\n');
            const found = [...blankNonCode(source).matchAll(CALL)].map(
                (m) => resolveKey(m[2].trim(), constants),
            );
            expect(found).toEqual([{ kind: 'literal', key: 'social.real' }]);
        });
    });
});
