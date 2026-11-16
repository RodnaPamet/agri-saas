/**
 * #3010 — a door that parses the moderation window must REPORT what it did.
 *
 * ## The defect
 *
 * `parseModerationWindow` falls back to 30 on an out-of-range, non-integer,
 * non-numeric or empty `windowDays`, and that default is KEPT by owner ruling
 * (2026-11-16): a script that has been sending a junk value for months keeps
 * working, which narrowing the contract to a 400 would have broken. So the fix
 * is not in the parser's verdict but in whether the caller is told — the
 * payload carries `windowDefaulted`, and a door that resolves a window without
 * passing it on answers 30 as though 30 had been asked for.
 *
 * ## Why a guard and not only the route suites
 *
 * There are TWO doors on this figure — the platform-key route for scripts and
 * the session-gated console — and #2735 extracted the parser precisely because
 * two local copies of the bound is the #1664 shape: one spelling moves, the
 * doors answer different questions, and nothing fails. The reporting half has
 * exactly the same exposure one field over, and it is worse in one respect: a
 * door that silently drops the verdict is indistinguishable from a request that
 * was honoured, so its own tests pass whatever it does.
 *
 * The population is DERIVED from the filesystem — every file calling
 * `parseModerationWindow` — so a THIRD door fails here the moment it exists,
 * which is the case neither route's unit suite can cover.
 *
 * ## What it deliberately does NOT assert
 *
 * That the verdict reaches the response BODY. A text scan cannot follow
 * `withWindowVerdict(...)`'s return into `jsonResponse`, and a guard asserting
 * an adjacency would be decoration — `a-gate-only-binds-what-it-execs`. The
 * behavioural half is in `moderation-statements-metrics-session-routes`, which
 * reads `windowDefaulted` out of the parsed JSON on both the honoured and the
 * refused paths. This guard answers the question that suite structurally
 * cannot: whether every door is wired at all.
 */
import { readFileSync } from 'fs';
import { relative } from 'path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectTrackedFiles } from '../helpers/collect-files';

const ROOT = process.cwd();

/**
 * CALLING the parser — never DECLARING it.
 *
 * The lookbehind is load-bearing and the guard's first run is why: without it
 * `export function parseModerationWindow(raw: string | null)` matched, so
 * `query-params.ts` joined the population and failed for not calling
 * `withWindowVerdict` — which it defines. A definition is not a door, and a
 * guard that cannot tell the two apart reports the module holding the rule as
 * the module breaking it.
 */
const PARSES = /(?<!function\s)parseModerationWindow\s*\(/;

/** Reporting the verdict. Any call in the file — placement is not this guard's job. */
const REPORTS = /withWindowVerdict\s*\(/;

/**
 * Doors that resolve a window and deliberately do not report the verdict, each
 * with a written reason.
 *
 * EMPTY today, and that is the point: both doors report, so the population is
 * fully covered rather than mostly covered. An entry here is a decision about
 * a caller who will misread a figure, not a convenience.
 */
const EXEMPT: Readonly<Record<string, string>> = {};

function sources(): { path: string; code: string }[] {
    return collectTrackedFiles({
        roots: ['src'],
        extensions: ['.ts', '.tsx'],
        // `src` + `.ts` — the default skip list drops `dist`/`coverage` BY NAME
        // and would hide a real API route under a directory of that name.
        skipDirs: ['node_modules', '.next', 'generated'],
        floor: 400,
    }).map((abs) => ({
        path: relative(ROOT, abs),
        // Blanked, so a file EXPLAINING the rule without obeying it still
        // fails. `a-scar-is-not-a-wound`: a comment hit usually means the
        // pattern was REMOVED.
        code: blankNonCode(readFileSync(abs, 'utf8')),
    }));
}

describe('#3010 — the window verdict reaches every door', () => {
    const parsers = sources().filter((f) => PARSES.test(f.code));

    it('[moderation-window-doors] prints its denominator', () => {
        const names = parsers.map((f) => f.path).sort();
        console.log(
            `[moderation-window-doors] ${names.length} door(s) resolve a moderation `
                + `window; ${names.filter((n) => !(n in EXEMPT)).length} must report the `
                + `verdict. ${names.join(', ')}`,
        );
        expect(names.length).toBeGreaterThan(0);
    });

    it('CONTROL — the two known doors are in the population', () => {
        // Without this the guard passes for free the day the parser is renamed
        // and every `PARSES` test goes false: zero doors, zero failures.
        const paths = parsers.map((f) => f.path);
        expect(paths).toContain('src/app/api/admin/moderation/metrics/route.ts');
        expect(paths).toContain(
            'src/app/api/t/[tenantSlug]/admin/moderation/metrics/route.ts',
        );
    });

    it('CONTROL — the module DECLARING the parser is not a door', () => {
        // The lookbehind, proved. `query-params.ts` defines both halves and
        // calls neither; if it is in the population the guard is grading the
        // rule's own home, and the only way to make it pass would be a
        // meaningless self-call or an exemption for the one file that cannot
        // be wrong.
        expect(parsers.map((f) => f.path)).not.toContain('src/lib/validation/query-params.ts');
        expect(PARSES.test('export function parseModerationWindow(raw: string | null) {')).toBe(
            false,
        );
        expect(PARSES.test('const r = parseModerationWindow(raw);')).toBe(true);
    });

    it('CONTROL — the detector can tell a wired door from an unwired one', () => {
        // The selector proved against crafted sources, because every real door
        // is compliant: with nothing failing, a detector that matches anything
        // and a detector that matches nothing look alike.
        const wired = 'const r = parseModerationWindow(x);\nreturn j(withWindowVerdict(s, r));';
        const unwired = 'const r = parseModerationWindow(x);\nreturn j(s);';
        expect(PARSES.test(wired) && REPORTS.test(wired)).toBe(true);
        expect(PARSES.test(unwired)).toBe(true);
        expect(REPORTS.test(unwired)).toBe(false);
        // And a comment ABOUT the rule is not obedience to it.
        expect(REPORTS.test(blankNonCode('// calls withWindowVerdict(s, r)'))).toBe(false);
    });

    it.each(parsers.map((f) => [f.path, f.code] as const))(
        '%s reports the verdict',
        (path, code) => {
            if (path in EXEMPT) {
                expect(EXEMPT[path].length).toBeGreaterThan(20);
                return;
            }
            expect(REPORTS.test(code)).toBe(true);
        },
    );
});
