/**
 * The GHSA-mfr8-8qww-v76h exemption rests on an ABSENCE, and this holds it.
 *
 * `scripts/audit-exemptions.mjs` exempts that advisory — information
 * disclosure across root params when a `'use cache'` function is called
 * through `unstable_cache()` — on the ground that neither half of the
 * vulnerable shape exists in this codebase. The advisory needs BOTH: a cached
 * function to leak, and an `unstable_cache()` call to reach it through.
 *
 * ## Why a guard and not the `review` date
 *
 * The review date bounds how long an accepted risk may be forgotten. It does
 * not notice the risk CHANGING. The entry immediately above this one in that
 * file is the worked example: the node-forge exemption's rationale "was TRUE
 * when written and is now FALSE", and nothing said so — it expired on a
 * premise, not on a date, and was caught only when eleven fresh advisories
 * landed on the same package.
 *
 * The change that would do it here is ordinary and would look harmless: adding
 * a `'use cache'` function, or reaching for `unstable_cache` to memoise a slow
 * read. At that moment a REQUIRED security gate would be passing on a written
 * argument that had silently stopped being true, and the only thing standing
 * between the two is this file.
 *
 * ## The four terms, and why all four
 *
 * Pinning only `unstable_cache` would pass the day somebody adds a cached
 * function, and vice versa — so both halves are asserted, plus the two
 * `next.config.js` flags that enable the caching machinery at all
 * (`cacheComponents`, `dynamicIO`). A config flag is included because enabling
 * one is how a codebase acquires the feature wholesale rather than one call
 * site at a time.
 *
 * ## Two ways this guard could be green while blind
 *
 * Both are controlled for, because the subject is an absence and an absence is
 * what a broken detector also reports.
 *
 *   1. **Seeing nothing.** A detector pointed at an empty file list satisfies
 *      every negated assertion. So the scanned population is floored and
 *      printed.
 *   2. **A pattern that cannot match.** Each detector is run against synthetic
 *      source that DOES contain what it hunts, and must find it. Without that,
 *      a typo'd regex is indistinguishable from a clean codebase.
 *
 * ## The false positive that made the naive detector wrong
 *
 * `src/app-layer/usecases/soil.ts` contains the words "re**use cache**d" in a
 * docblock. A bare `use cache` substring matches it, so the first measurement
 * of this premise reported a `'use cache'` directive that does not exist. Two
 * fixes, both kept: comments are blanked with the shared `blankNonCode` (never
 * a local stripper — see #1497 / #1774), and the pattern requires the QUOTED
 * directive rather than the bare words. The prose case is asserted as a
 * control, so a future loosening back to a substring match fails here.
 *
 * Strings are deliberately NOT blanked: the `'use cache'` directive IS a
 * string literal, so blanking strings would make the thing being hunted
 * invisible — the `pages-are-reachable` precedent.
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

/** A caching feature flag switched on in next.config. */
const CACHE_FLAGS = /\b(cacheComponents|dynamicIO)\b/;

const SRC_FILES = collectSourceFiles({ roots: [path.join(REPO_ROOT, 'src')] });

/**
 * A floor, not an equality: `src/` grows constantly. It exists so a detector
 * that stopped resolving the tree fails instead of passing over nothing.
 */
const MIN_SCANNED_FILES = 2000;

interface Hit {
    rel: string;
    line: number;
    text: string;
}

function scan(pattern: RegExp): Hit[] {
    const hits: Hit[] = [];
    for (const abs of SRC_FILES) {
        const code = blankComments(fs.readFileSync(abs, 'utf8'));
        code.split('\n').forEach((text, i) => {
            if (pattern.test(text)) {
                hits.push({
                    rel: path.relative(REPO_ROOT, abs).split(path.sep).join('/'),
                    line: i + 1,
                    text: text.trim().slice(0, 120),
                });
            }
        });
    }
    return hits;
}

describe(`the ${ADVISORY_ID} exemption's premise still holds`, () => {
    const exemptionsSrc = fs.readFileSync(
        path.join(REPO_ROOT, 'scripts/audit-exemptions.mjs'),
        'utf8',
    );
    const isExempt = new RegExp(`id:\\s*(['"])${ADVISORY_ID}\\1`).test(exemptionsSrc);

    const unstableCacheHits = scan(UNSTABLE_CACHE);
    const useCacheHits = scan(USE_CACHE_DIRECTIVE);

    const nextConfigRaw = fs.readFileSync(path.join(REPO_ROOT, 'next.config.js'), 'utf8');
    const nextConfigCode = blankComments(nextConfigRaw);
    const cacheFlagHit = CACHE_FLAGS.exec(nextConfigCode);

    it('prints its denominator and the four terms', () => {
        console.log(
            `[next-use-cache-advisory] exempt=${isExempt} scanned=${SRC_FILES.length} files ` +
                `(floor ${MIN_SCANNED_FILES})`,
        );
        console.log(
            `[next-use-cache-advisory] unstable_cache=${unstableCacheHits.length} ` +
                `'use cache'=${useCacheHits.length} ` +
                `configFlag=${cacheFlagHit ? cacheFlagHit[1] : 'none'}`,
        );
        expect(SRC_FILES.length).toBeGreaterThanOrEqual(MIN_SCANNED_FILES);
    });

    describe('the detectors can actually see (positive controls)', () => {
        it('finds an unstable_cache call', () => {
            expect(
                UNSTABLE_CACHE.test("import { unstable_cache } from 'next/cache';"),
            ).toBe(true);
            expect(UNSTABLE_CACHE.test('const f = unstable_cache(read, [k]);')).toBe(true);
        });

        it('finds a quoted `use cache` directive in either quote style', () => {
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
            const commented = blankComments("// we deliberately do not use 'use cache' here\n");
            expect(USE_CACHE_DIRECTIVE.test(commented)).toBe(false);
            expect(USE_CACHE_DIRECTIVE.test("'use cache';\n")).toBe(true);
        });
    });

    describe('while the advisory is exempt, all four terms must hold', () => {
        it('RETIRES ITSELF when the exemption goes, rather than becoming decoration', () => {
            // Measured: gating the three assertions below on `isExempt` and
            // leaving this as a `typeof` placebo made the whole file pass,
            // green and silent, once the exemption was removed — the guard
            // would have gone on reporting success while asserting nothing,
            // which is the `absence-reads-as-success` shape it exists to
            // prevent in the first place.
            //
            // So this fails the moment the entry goes. The required action is
            // to DELETE this file in that same PR: with no exemption there is
            // no premise to hold, and `npm audit` is then the whole control
            // again. That mirrors the exemption list's own rule 3, which
            // requires the entry's deletion to ship with the upgrade.
            expect(isExempt).toBe(true);
        });

        it('has no `unstable_cache` call site under src/', () => {
            expect(unstableCacheHits).toEqual([]);
        });

        it("has no `'use cache'` directive under src/", () => {
            expect(useCacheHits).toEqual([]);
        });

        it('enables neither cacheComponents nor dynamicIO', () => {
            // Any occurrence fails, including `: false`. A security premise is
            // worth re-arguing by hand when the surrounding config acquires the
            // flag at all — the safe direction.
            expect(cacheFlagHit?.[1] ?? null).toBeNull();
        });
    });
});
