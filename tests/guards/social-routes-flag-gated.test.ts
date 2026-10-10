/**
 * Every social surface sits behind a runtime feature flag, default OFF.
 *
 * That is a standing rule of the social-network roadmap, not a nicety: the
 * surfaces P2-P6 build are public-facing and legally consequential, and the
 * only agreed way to turn one off in production is a flag flip. A social route
 * that forgot its gate is a surface with no off switch — discoverable the
 * moment it merges, removable only by shipping an image.
 *
 * ── the population is ZERO TODAY, which is the whole problem with this guard ──
 *
 * No social routes exist yet; P0.4 builds the MECHANISM. An empty selection is a
 * PASS, and this repo has shipped that defect often enough to name it: a guard
 * whose population is zero reports success forever and nobody notices when it
 * stops meaning anything. So this file does three things instead of one:
 *
 *   1. It PRINTS the denominator unconditionally, so a reader of CI output can
 *      see the population rather than infer it from a green tick.
 *   2. It proves the detector has teeth against SYNTHETIC sources — a gated
 *      route and an ungated one — which is the only mutation proof available
 *      before the first real social route exists. When one does exist, mutate
 *      it directly; the synthetic control stays as the floor.
 *   3. It defends its own ROOTS. A guard anchored on `api/social` is blind to a
 *      surface that lands at `api/t/[slug]/social` or `api/me/social`, and
 *      blind in the direction that reports green. So every route path and page
 *      path containing a `social` segment must fall under a declared root — a
 *      new root is then a visible line in the diff that adds it, which is the
 *      same shape as the undocumented-route ceiling.
 *
 * ── what counts as gated ──
 *
 * A call to `assertFeatureEnabled` or `isFeatureEnabled` from
 * `@/lib/feature-flags`, with a STRING LITERAL key. The literal matters: an
 * operator holding the flag console has to be able to find the flag that gates
 * a route, and a key assembled at runtime is not findable by reading the route.
 * The keys are additionally held to the same grammar the console's `FlagKey`
 * accepts, so a route cannot be gated on a key the console refuses to create.
 *
 * ── the exemption class, and why it is empty rather than pre-populated ──
 *
 * Account deletion and the DSA notice endpoints are LEGAL DUTIES and are
 * exempt from flags — a right to erasure behind a switch somebody can turn off
 * is not a right. Those routes do not exist yet, and an exemption for a path
 * that does not exist is cover for a path that might never match it, so
 * `FLAG_EXEMPT` starts empty and a stale-entry test keeps it that way. Add the
 * entry in the PR that adds the route, with the duty named.
 *
 * ── this is the SERVER half ──
 *
 * It cannot see an iOS screen that renders a social surface without consulting
 * the flags store; that is P0.9's job on the client. Same two-direction
 * argument as `route-inventory-ledger` and `public-routes-self-authenticate`:
 * neither half subsumes the other.
 */
import fs from 'fs';
import path from 'path';
import { ROOT, routeFiles } from '../../scripts/lib/api-routes';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';
/**
 * The key grammar is IMPORTED, not restated.
 *
 * It began as a copy of the console route's regex with a note explaining why
 * the duplication was acceptable. It was not: the thing this check asserts is
 * that the console and the gate agree, and a check that owns its own copy of
 * one side's rule cannot see them disagree. `FLAG_KEY_PATTERN` now lives in
 * `@/lib/feature-flags`, which both the route and this guard import — plain TS,
 * no Next route module pulled into a guard.
 */
import { FLAG_KEY_PATTERN, FLAG_KEY_MAX_LENGTH } from '../../src/lib/feature-flags';
import { blankNonCode } from '../helpers/blank-non-code';

/**
 * Where a social API route may live. A path containing a `social` segment
 * outside these roots fails the roots test below rather than being silently
 * excluded from the population.
 */
const SOCIAL_API_ROOTS = ['src/app/api/social/'] as const;

/**
 * Where a social PAGE may live. Both spellings are declared up front because
 * Next route groups are invisible in the URL — `src/app/(social)/feed/page.tsx`
 * and `src/app/social/feed/page.tsx` are different trees serving related URLs,
 * and a guard that knew only one of them would be half blind.
 */
const SOCIAL_PAGE_ROOTS = ['src/app/social/', 'src/app/(social)/'] as const;

/**
 * Paths exempt from the flag rule, keyed by repo-relative file path, each with
 * the legal duty that makes the flag inapplicable. See the docblock: this is
 * empty on purpose and entries land with their routes.
 */
const FLAG_EXEMPT: Readonly<Record<string, string>> = {
    // The FIRST entry, and the key is a repo-relative FILE path — this map is
    // checked against `routeFiles()` and against the declared social roots, so
    // a URL-shaped key would be an exemption for a path the population never
    // selects: cover that protects nothing and hides that the rule was never
    // applied. (I wrote URLs first and this is what caught it.)
    //
    // DSA Art 16 requires a notice mechanism, and a legal duty cannot be
    // dark-launched: a flag defaulting OFF means the obligation is unmet until
    // someone remembers to flip it, and "it was behind a flag" is not an answer
    // to a regulator. Art 16 applies to a notifier who happens to have an
    // account as much as to one who does not, so gating this would gate the
    // duty for exactly the people most likely to exercise it.
    //
    // The ANONYMOUS half of the same duty lives at
    // `src/app/api/public/notices/route.ts` and is deliberately NOT listed: it
    // has no `social` path segment, so this guard's population never selects
    // it, and an entry here would be the stale cover described above. Its
    // unauthenticated nature is exempted where that IS checked —
    // `tests/guards/public-routes-self-authenticate.test.ts`.
    //
    // What is NOT exempt: the person BLOCK routes (P5.2b). Blocking is an
    // Apple 1.2 requirement and a product feature, so it stays gated. That
    // difference is the seam P5.2 is split along. P5.4's moderation console,
    // which ACTS on a notice, is likewise a different question.
    'src/app/api/social/reports/route.ts':
        'DSA Art 16 — the signed-in half of the notice mechanism. A legal duty, '
        + 'so it cannot default OFF. See the route docblock.',
};

/** The gate callees that count. Both resolve rule 1 (the kill switch) first. */
const GATE_CALLEES = ['assertFeatureEnabled', 'isFeatureEnabled'] as const;

/** Mask comments so a gate named only in prose cannot satisfy the guard. */
function codeOf(source: string): string {
    return blankNonCode(source);
}

/** The flag keys a source gates on, from literal arguments only. */
function gateKeys(source: string): string[] {
    const code = codeOf(source);
    const keys: string[] = [];
    for (const callee of GATE_CALLEES) {
        // Built by CONCATENATION, not a template literal, and that is the
        // second thing this line taught me. The body has to exclude `$` and
        // `{` as well as the quote characters — the mutation proof caught
        // that: a backtick template like a dollar-brace interpolation contains
        // no quote character, so a quotes-only body matched it end to end and
        // an INTERPOLATED key read as a literal one, precisely the computed
        // key this check exists to refuse. `+` rather than `*` closes the same
        // hole in the other direction, since an empty literal is not a
        // findable flag key.
        //
        // Writing that character class inside a template literal needed `\$`
        // to stop the `${` being read as interpolation — correct, and CodeQL
        // flagged it `js/useless-regexp-character-escape` because `\$` and `$`
        // are the same character and a reader cannot tell which meaning was
        // intended. It was right to: the line had already been wrong twice.
        // Concatenation has no template-escape layer, so the regex source
        // reads as itself.
        const re = new RegExp(
            '\\b' + callee + '\\s*\\(\\s*([\'"`])([^\'"`${}]+)\\1',
            'g',
        );
        for (const m of code.matchAll(re)) keys.push(m[2]);
    }
    return keys;
}

/** Is this source gated — a gate callee present with at least one literal key? */
function isGated(source: string): boolean {
    return gateKeys(source).length > 0;
}

/**
 * Every `page.tsx` under `src/app`, repo-relative.
 *
 * Collected over the WHOLE app tree and then filtered, rather than walked from
 * each social root — and the difference is the bug this file started with. The
 * first version walked `src/app/social/` and returned `[]` when the directory
 * did not exist, which is the same answer it would give for a root that had
 * been RENAMED: a failed look reported as a measurement of zero. Two meta-
 * guards caught it (`scan-roots-resolve`, `file-collection-is-not-silently-
 * empty`), which is the system working.
 *
 * `collectSourceFiles` throws on a root that does not resolve and enforces a
 * floor, so the DENOMINATOR here is verified. The social subset is then a plain
 * prefix filter over a known-complete list, and a zero in it is a fact about
 * the repo rather than about the walk.
 */
function allAppPages(): string[] {
    return collectSourceFiles({
        roots: ['src/app'],
        extensions: ['.tsx'],
        exclude: (rel) => !rel.endsWith('/page.tsx'),
        // Well under the ~92 that exist: high enough that an exclude predicate
        // eating the population fails, low enough not to need editing when a
        // page is deleted.
        floor: 50,
    }).map((abs) => path.relative(REPO_ROOT, abs).split(path.sep).join('/'));
}

/** Is a repo-relative path inside a declared social root? */
function isUnderSocialRoot(rel: string): boolean {
    return [...SOCIAL_API_ROOTS, ...SOCIAL_PAGE_ROOTS].some((r) => rel.startsWith(r));
}

const ALL_ROUTES = routeFiles();
const ALL_PAGES = allAppPages();

const SOCIAL_ROUTES = ALL_ROUTES.filter((f) => SOCIAL_API_ROOTS.some((r) => f.startsWith(r)));
const SOCIAL_PAGES = ALL_PAGES.filter((f) => SOCIAL_PAGE_ROOTS.some((r) => f.startsWith(r)));
const SOCIAL_SURFACES = [...SOCIAL_ROUTES, ...SOCIAL_PAGES];

/** A `social` path SEGMENT — not a substring, so `socialise/` does not match. */
function hasSocialSegment(relPath: string): boolean {
    return relPath.split('/').includes('social');
}

describe('every social surface is behind a runtime feature flag', () => {
    it('reports the population it examined, including when that is zero', () => {
        // No eslint-disable: `no-console` does not apply under tests/, so a
        // directive here would be UNUSED — and an unused directive is itself a
        // lint finding that counts against the suppression ceiling.
        // Printed unconditionally. The failure mode this guard exists inside is
        // a selection that quietly became empty, and the only cheap defence is
        // making the number visible on every run rather than on failure.
        const banner =
            `[social-flag-gating] routes=${SOCIAL_ROUTES.length} ` +
            `pages=${SOCIAL_PAGES.length} exempt=${Object.keys(FLAG_EXEMPT).length} ` +
            `(of ${ALL_ROUTES.length} API routes, ${ALL_PAGES.length} app pages)`;
        console.log(banner);
        if (SOCIAL_SURFACES.length === 0) {
                console.log(
                '[social-flag-gating] NO SOCIAL SURFACES EXIST YET — the assertions below ' +
                    'range over nothing. The detector is proved against synthetic sources ' +
                    'in the "has teeth" block; treat a green run here as "the mechanism ' +
                    'works", never as "the surfaces are gated".',
            );
        }
        expect(ALL_ROUTES.length).toBeGreaterThan(300);
        expect(ALL_PAGES.length).toBeGreaterThan(50);
    });

    it('every social route gates on a literal flag key', () => {
        const ungated = SOCIAL_ROUTES.filter(
            (f) => !(f in FLAG_EXEMPT) && !isGated(fs.readFileSync(path.join(ROOT, f), 'utf8')),
        );
        expect(ungated).toEqual([]);
    });

    it('every social page gates on a literal flag key', () => {
        const ungated = SOCIAL_PAGES.filter(
            (f) => !(f in FLAG_EXEMPT) && !isGated(fs.readFileSync(path.join(ROOT, f), 'utf8')),
        );
        expect(ungated).toEqual([]);
    });

    it('every gate key is one the flag console can create', () => {
        // A route gated on a key the console refuses would be a surface with a
        // gate and no way to open it — off forever, which reads as "not built".
        const bad: string[] = [];
        for (const f of SOCIAL_SURFACES) {
            for (const key of gateKeys(fs.readFileSync(path.join(ROOT, f), 'utf8'))) {
                if (!FLAG_KEY_PATTERN.test(key) || key.length > FLAG_KEY_MAX_LENGTH) bad.push(`${f}: ${key}`);
            }
        }
        expect(bad).toEqual([]);
    });
});

describe('the roots this guard trusts are the only places social surfaces live', () => {
    it('no API route outside the declared roots has a `social` path segment', () => {
        const strays = ALL_ROUTES.filter(
            (f) => hasSocialSegment(f) && !SOCIAL_API_ROOTS.some((r) => f.startsWith(r)),
        );
        // Landing a social route elsewhere is allowed — but it costs a root
        // added to SOCIAL_API_ROOTS in the same diff, not an exclusion from the
        // population by accident of where the directory sits.
        expect(strays).toEqual([]);
    });

    it('no app page outside the declared roots has a `social` path segment', () => {
        const strays = ALL_PAGES.filter(
            (f) => hasSocialSegment(f) && !SOCIAL_PAGE_ROOTS.some((r) => f.startsWith(r)),
        );
        expect(strays).toEqual([]);
    });

    it('the root selector can actually select — a control for the zero population', () => {
        // With no social surfaces on disk, `SOCIAL_ROUTES` and `SOCIAL_PAGES`
        // are empty whether the roots are right or nonsense. This is what
        // separates those two worlds.
        expect(isUnderSocialRoot('src/app/api/social/feed/route.ts')).toBe(true);
        expect(isUnderSocialRoot('src/app/social/feed/page.tsx')).toBe(true);
        expect(isUnderSocialRoot('src/app/(social)/feed/page.tsx')).toBe(true);
        expect(isUnderSocialRoot('src/app/api/t/[tenantSlug]/social/route.ts')).toBe(false);
        expect(isUnderSocialRoot('src/app/api/journal/route.ts')).toBe(false);
    });
});

describe('the detector has teeth', () => {
    // The mutation proof. With a real population this would mutate a real
    // route; with none it must still be impossible for this file to be green
    // because `isGated` always returns true.
    const GATED = `
        import { assertFeatureEnabled } from '@/lib/feature-flags';
        export const GET = withApiErrorHandling(async (req) => {
            await assertFeatureEnabled('social.profiles', userId);
            return jsonResponse({ ok: true });
        });
    `;

    it('accepts a gated source — the positive control', () => {
        expect(isGated(GATED)).toBe(true);
        expect(gateKeys(GATED)).toEqual(['social.profiles']);
    });

    it.each([
        ['no gate at all', GATED.replace(/await assertFeatureEnabled[^\n]*\n/, '')],
        ['gate named only in a line comment', GATED.replace(/await assertFeatureEnabled/, '// assertFeatureEnabled')],
        [
            'gate named only in a block comment',
            GATED.replace(/await assertFeatureEnabled\('social.profiles', userId\);/, '/* assertFeatureEnabled("social.profiles") */'),
        ],
        ['a computed key rather than a literal', GATED.replace(/'social\.profiles'/, 'FLAG_KEYS.profiles')],
        ['a template key with interpolation', GATED.replace(/'social\.profiles'/, '`social.${surface}`')],
        [
            'a template key interpolated at the front',
            GATED.replace(/'social\.profiles'/, '`${ns}.profiles`'),
        ],
        ['an empty literal key', GATED.replace(/'social\.profiles'/, "''")],
    ])('rejects: %s', (_label, mutated) => {
        expect(isGated(mutated)).toBe(false);
    });

    it('rejects a key the console would refuse', () => {
        const shouty = GATED.replace(/'social\.profiles'/, "'Social.Profiles'");
        expect(gateKeys(shouty)).toEqual(['Social.Profiles']);
        expect(FLAG_KEY_PATTERN.test('Social.Profiles')).toBe(false);
    });

    it('a `social` path SEGMENT is matched and a substring is not', () => {
        expect(hasSocialSegment('src/app/api/social/feed/route.ts')).toBe(true);
        expect(hasSocialSegment('src/app/api/t/[tenantSlug]/social/route.ts')).toBe(true);
        expect(hasSocialSegment('src/app/api/socialise/route.ts')).toBe(false);
        expect(hasSocialSegment('src/app/api/antisocial-media/route.ts')).toBe(false);
    });
});

describe('no stale exemptions', () => {
    it('every FLAG_EXEMPT entry names a file that exists and has a reason', () => {
        for (const [rel, reason] of Object.entries(FLAG_EXEMPT)) {
            expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
            expect(reason.length).toBeGreaterThan(20);
        }
    });

    it('every FLAG_EXEMPT entry is inside a declared social root', () => {
        // An exemption for a path the population never selects is cover that
        // protects nothing and hides that the rule was never applied.
        for (const rel of Object.keys(FLAG_EXEMPT)) {
            const inRoot =
                SOCIAL_API_ROOTS.some((r) => rel.startsWith(r)) ||
                SOCIAL_PAGE_ROOTS.some((r) => rel.startsWith(r));
            expect(inRoot).toBe(true);
        }
    });
});
