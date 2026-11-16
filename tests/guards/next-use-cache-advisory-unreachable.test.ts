/**
 * The GHSA-mfr8-8qww-v76h exemption rests on an ABSENCE, and this holds it.
 *
 * `scripts/audit-exemptions.mjs` exempts that advisory — information
 * disclosure across root params when a `'use cache'` function is called
 * through `unstable_cache()` — on the ground that neither half of the
 * vulnerable shape exists in this codebase. The advisory needs BOTH: a cached
 * function to leak, and an `unstable_cache()` call to reach it through.
 *
 * ## Why a guard rather than the `review` date
 *
 * The review date bounds how long an accepted risk may be forgotten. It does
 * not notice the risk CHANGING. The node-forge entry in that same file is the
 * worked example: its rationale "was TRUE when written and is now FALSE", and
 * nothing said so — it expired on a premise, not on a date, and surfaced only
 * when eleven fresh advisories landed on the same package.
 *
 * The change that would do it here is ordinary and would look harmless in
 * review: adding a `'use cache'` function, or reaching for `unstable_cache` to
 * memoise a slow read. At that moment a REQUIRED security gate would be
 * passing on a written argument that had silently stopped being true.
 *
 * ## The four terms, and why all four
 *
 * Pinning only `unstable_cache` would pass the day somebody adds a cached
 * function, and vice versa — so both halves are asserted, plus the two
 * `next.config.js` flags that enable the caching machinery at all
 * (`cacheComponents`, `dynamicIO`). A config flag is included because enabling
 * one is how a codebase acquires the feature wholesale rather than one call
 * site at a time. Any occurrence fails, `: false` included: a security premise
 * is worth re-arguing by hand once the config knows the word at all.
 *
 * ## The roots are `src/` AND `scripts/`, minus ONE file
 *
 * The exemption's own reason claims zero call sites under `src/` **or**
 * `scripts/`, so scanning `src/` alone would leave half of what it asserts
 * unguarded.
 *
 * `scripts/audit-exemptions.mjs` is excluded BY NAME, because it is the
 * document that justifies the exemption and therefore quotes the very terms
 * this guard hunts. Measured: it is the only file under `scripts/` matching
 * either detector, and it matches BOTH — and it does so even after comments
 * are blanked, because the surviving occurrences sit in the `reason:` STRING
 * (lines 127/129/131), and strings are deliberately not blanked. Scanning it
 * would fail this guard permanently on its own justification. That is
 * self-reference, not a finding.
 *
 * That is a sharper version of the "reuse cached" trap below: the first is
 * prose that reads like code, this is a justification matching its own
 * subject. Neither is merely avoided — both carry controls.
 *
 * ## Three ways an absence-guard is green while blind
 *
 * The subject is an absence, and an absence is also what a broken detector
 * reports. So:
 *
 *   1. **Seeing no files.** A detector pointed at an empty list satisfies
 *      every negated assertion. The population is floored and printed.
 *   2. **A pattern that cannot match.** Each regex is run against synthetic
 *      source that DOES contain what it hunts.
 *   3. **A dead SELECTOR.** This is the one that bit, and the regex controls
 *      did not cover it: `selector-teeth` gutted `scan()` to `return []` and
 *      `blankComments()` to `return ''`, and every assertion still passed,
 *      because they all assert EMPTY. So `scan` takes its file list as a
 *      PARAMETER, and a control runs the real `scan` over the one file known
 *      to contain both terms and requires a non-empty result. That control
 *      kills both mutations at once — a gutted `blankComments` erases the
 *      known-positive content too — and it doubles as proof the exclusion is
 *      load-bearing rather than an omission.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

const ADVISORY_ID = 'GHSA-mfr8-8qww-v76h';

/** Comments only. The directive is a string literal, so strings must survive. */
const blankComments = (src: string): string => blankNonCode(src, { strings: false });

/** The `unstable_cache` import or call. */
const UNSTABLE_CACHE = /\bunstable_cache\b/;

/**
 * The QUOTED directive, never the bare words — "reuse cached" is prose and
 * matches the bare form.
 */
const USE_CACHE_DIRECTIVE = /(['"`])use cache\1/;

/** A caching feature flag named in next.config. */
const CACHE_FLAGS = /\b(cacheComponents|dynamicIO)\b/;

const rel = (abs: string): string =>
    path.relative(REPO_ROOT, abs).split(path.sep).join('/');

/**
 * The exemption's own justification. Quotes both hunted terms, so it is
 * excluded from the scan — and is therefore exactly the right known-positive
 * input for the selector controls.
 */
const SELF_REFERENTIAL = 'scripts/audit-exemptions.mjs';
const SELF_REFERENTIAL_ABS = path.join(REPO_ROOT, SELF_REFERENTIAL);

const SCANNED_FILES = [
    ...collectSourceFiles({ roots: [path.join(REPO_ROOT, 'src')] }),
    ...collectSourceFiles({
        roots: [path.join(REPO_ROOT, 'scripts')],
        extensions: ['.ts', '.tsx', '.mjs', '.js'],
    }),
].filter((abs) => rel(abs) !== SELF_REFERENTIAL);

/**
 * A floor, not an equality: both roots grow. It exists so a detector that
 * stopped resolving the tree fails instead of passing over nothing.
 */
const MIN_SCANNED_FILES = 2000;

interface Hit {
    rel: string;
    line: number;
    text: string;
}

/**
 * `files` is a PARAMETER so a control can aim the real selector at a
 * known-positive input. Defaulting it keeps the call sites readable.
 */
function scan(pattern: RegExp, files: string[] = SCANNED_FILES): Hit[] {
    const hits: Hit[] = [];
    for (const abs of files) {
        const code = blankComments(fs.readFileSync(abs, 'utf8'));
        code.split('\n').forEach((text, i) => {
            if (pattern.test(text)) {
                hits.push({ rel: rel(abs), line: i + 1, text: text.trim().slice(0, 120) });
            }
        });
    }
    return hits;
}

describe(`the ${ADVISORY_ID} exemption's premise still holds`, () => {
    const exemptionsSrc = fs.readFileSync(SELF_REFERENTIAL_ABS, 'utf8');
    const isExempt = new RegExp(`id:\\s*(['"])${ADVISORY_ID}\\1`).test(exemptionsSrc);

    const unstableCacheHits = scan(UNSTABLE_CACHE);
    const useCacheHits = scan(USE_CACHE_DIRECTIVE);

    const nextConfigCode = blankComments(
        fs.readFileSync(path.join(REPO_ROOT, 'next.config.js'), 'utf8'),
    );
    const cacheFlagHit = CACHE_FLAGS.exec(nextConfigCode);

    it('prints its denominator and the four terms', () => {
        console.log(
            `[next-use-cache-advisory] exempt=${isExempt} scanned=${SCANNED_FILES.length} files ` +
                `(floor ${MIN_SCANNED_FILES}, excluding ${SELF_REFERENTIAL})`,
        );
        console.log(
            `[next-use-cache-advisory] unstable_cache=${unstableCacheHits.length} ` +
                `'use cache'=${useCacheHits.length} ` +
                `configFlag=${cacheFlagHit ? cacheFlagHit[1] : 'none'}`,
        );
        expect(SCANNED_FILES.length).toBeGreaterThanOrEqual(MIN_SCANNED_FILES);
    });

    describe('the SELECTOR can select (what the regex controls missed)', () => {
        it('finds both terms in the one file known to contain them', () => {
            // Kills `scan() → return []` AND `blankComments() → return ''`:
            // every other assertion here expects an empty result, so only a
            // positive expectation can notice a dead selector. It is also the
            // proof that excluding this file is load-bearing — if these stop
            // matching, the exemption's reason was reworded and
            // `SELF_REFERENTIAL` should be dropped from the filter rather than
            // left covering a file that is now scannable.
            expect(scan(UNSTABLE_CACHE, [SELF_REFERENTIAL_ABS]).length).toBeGreaterThan(0);
            expect(scan(USE_CACHE_DIRECTIVE, [SELF_REFERENTIAL_ABS]).length).toBeGreaterThan(0);
        });

        it('excludes exactly that file, and keeps both roots in the population', () => {
            expect(SCANNED_FILES.map(rel)).not.toContain(SELF_REFERENTIAL);
            expect(SCANNED_FILES.some((a) => rel(a).startsWith('src/'))).toBe(true);
            expect(SCANNED_FILES.some((a) => rel(a).startsWith('scripts/'))).toBe(true);
        });
    });

    describe('the regexes can match (positive controls)', () => {
        it('finds an unstable_cache call', () => {
            expect(UNSTABLE_CACHE.test("import { unstable_cache } from 'next/cache';")).toBe(true);
            expect(UNSTABLE_CACHE.test('const f = unstable_cache(read, [k]);')).toBe(true);
        });

        it('finds a quoted `use cache` directive in every quote style', () => {
            expect(USE_CACHE_DIRECTIVE.test("'use cache';")).toBe(true);
            expect(USE_CACHE_DIRECTIVE.test('"use cache";')).toBe(true);
            expect(USE_CACHE_DIRECTIVE.test('`use cache`;')).toBe(true);
        });

        it('finds a caching flag in a config literal', () => {
            expect(CACHE_FLAGS.test('experimental: { cacheComponents: true },')).toBe(true);
            expect(CACHE_FLAGS.test('experimental: { dynamicIO: true },')).toBe(true);
        });

        it('does NOT match the "reuse cached" prose that broke the naive version', () => {
            const prose = ' * Fetch (or reuse cached) soil for one parcel and persist it.';
            expect(USE_CACHE_DIRECTIVE.test(prose)).toBe(false);
            expect(/use cache/.test(prose)).toBe(true); // the bare form DOES — hence the quotes
        });

        it('ignores a directive that only appears in a comment', () => {
            expect(USE_CACHE_DIRECTIVE.test(blankComments("// not 'use cache' here\n"))).toBe(false);
            expect(USE_CACHE_DIRECTIVE.test("'use cache';\n")).toBe(true);
        });
    });

    describe('while the advisory is exempt, all four terms must hold', () => {
        it('RETIRES ITSELF when the exemption goes, rather than becoming decoration', () => {
            // Measured: gating the assertions below on `isExempt` and leaving a
            // `typeof` placebo here made the whole file pass, green and silent,
            // once the exemption was removed — the guard would have become
            // decoration at exactly the moment its subject changed.
            //
            // So this fails when the entry goes, and the required action is to
            // DELETE this file in that same PR: with no exemption there is no
            // premise to hold and `npm audit` is the whole control again. That
            // mirrors the exemption list's own rule 3.
            expect(isExempt).toBe(true);
        });

        it('has no `unstable_cache` call site under src/ or scripts/', () => {
            expect(unstableCacheHits).toEqual([]);
        });

        it("has no `'use cache'` directive under src/ or scripts/", () => {
            expect(useCacheHits).toEqual([]);
        });

        it('enables neither cacheComponents nor dynamicIO', () => {
            expect(cacheFlagHit?.[1] ?? null).toBeNull();
        });
    });
});
