/**
 * #3126 — a file that writes `MarketPricePoint` must also drop the read cache.
 *
 * ## The defect, and why the population matters more than the report
 *
 * `getPriceTrends` serves `trends:prices:v3:<locale>:<commodity>:<range>` from
 * Redis for SIX HOURS. A writer that does not invalidate is invisible until
 * each key expires.
 *
 * It was reported as "the ZarnoBorsa ingest forgot". Measuring found THREE of
 * four writers missing it, and the two nobody had mentioned were the worse
 * half: `upsertManualPriceSeries` and `upsertOverrideDay`/`clearOverride` are
 * platform-admin paths, where a human is AT THE CONSOLE. A nightly pull being
 * six hours stale reads as lag; a correction that does not appear reads as the
 * console being broken. `clearOverride` is worse again in kind — its entire
 * purpose is to undo a wrong number, and the cache kept serving the wrong one.
 *
 * `market-prices-pull` had invalidated since it was written. The pattern was
 * simply not carried over, three times — which is why hand-wiring the three
 * and stopping would guarantee a fifth writer repeats it.
 *
 * ## DERIVED, so a fifth writer fails here
 *
 * The population is every file under `src/` that calls a write method on
 * `marketPricePoint`, read off the filesystem. Nothing is listed. A new writer
 * fails this guard until it invalidates or is recorded in `EXEMPT` with a
 * reason.
 *
 * Comments are blanked first: a file that EXPLAINS the rule without obeying it
 * must still fail, and `a-scar-is-not-a-wound` is the general case — a comment
 * hit usually means the pattern was REMOVED.
 *
 * ## What it deliberately does NOT assert
 *
 * WHERE the invalidation sits, or that the commodities passed are the right
 * ones. Both matter and neither is checkable by a text scan: the correct
 * placement differs per writer — `afterCommit` inside `runInTenantContext`
 * (which opens a db-context scope) versus a direct await where writes are
 * already committed individually, because `afterCommit` with no scope fires
 * un-awaited (#1619). A guard that insisted on one shape would be wrong for
 * half the population. The behavioural half lives in the suites that execute
 * these writers.
 */
import { readFileSync } from 'fs';
import { relative } from 'path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectTrackedFiles } from '../helpers/collect-files';

const ROOT = process.cwd();

/** Writes that create or change a price point. */
const POINT_WRITE = /marketPricePoint\s*\.\s*(?:create|createMany|upsert|update|updateMany)\b/;

/** The drop. Any call, anywhere in the file — placement is not this guard's job. */
const INVALIDATES = /invalidatePriceTrendsCache\s*\(/;

/**
 * Writers that legitimately do not invalidate, each with a written reason.
 *
 * EMPTY today, and that is the point: all four writers invalidate, so the
 * guard's population is fully covered rather than mostly covered. An entry
 * here is a decision, not a convenience.
 */
const EXEMPT: Readonly<Record<string, string>> = {};

/**
 * Each exported function's NAME and BODY, by brace matching.
 *
 * Brace-matched rather than regexed to the next `export`, because a nested
 * function or an object literal would end the match early and hand back a
 * truncated body — and a truncated body that happens to exclude the
 * invalidation is a false finding, while one that excludes the write is a
 * silent pass. `epic67`'s `extractHandlerBody` is the precedent, including its
 * documented trap: it matched only a handler whose `=>` sat on the declaration
 * line, so a `useCallback`-wrapped one extracted as the empty string.
 *
 * An empty extraction is therefore refused by the control test below rather
 * than tolerated.
 */
function exportedFunctions(src: string): { name: string; body: string }[] {
    const out: { name: string; body: string }[] = [];
    const decl = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = decl.exec(src)) !== null) {
        /*
         * The body's brace is the first one at ANGLE DEPTH ZERO after the
         * parameter list — not simply the first `{`.
         *
         * The control caught this: `export async function f(): Promise<{ a:
         * string }>` has a brace inside its RETURN TYPE, and taking that one
         * made the extracted body `{ a: string }`. Every writing function then
         * looked like it contained no write, so the per-function assertion
         * passed over nothing — vacuously, which is the failure the control is
         * there to refuse.
         */
        let open = -1;
        let angle = 0;
        let paren = 0;
        for (let k = m.index + m[0].length - 1; k < src.length; k += 1) {
            const c = src[k];
            if (c === '(') paren += 1;
            else if (c === ')') paren -= 1;
            else if (paren === 0 && c === '<') angle += 1;
            else if (paren === 0 && c === '>') angle -= 1;
            else if (paren === 0 && angle === 0 && c === '{') {
                open = k;
                break;
            }
            else if (paren === 0 && angle === 0 && c === ';') break; // an overload signature
        }
        if (open === -1) continue;
        let depth = 0;
        let i = open;
        for (; i < src.length; i += 1) {
            if (src[i] === '{') depth += 1;
            else if (src[i] === '}') {
                depth -= 1;
                if (depth === 0) break;
            }
        }
        out.push({ name: m[1], body: src.slice(open, i + 1) });
    }
    return out;
}

function code(file: string): string {
    return blankNonCode(readFileSync(file, 'utf8'), { strings: false });
}

describe('every MarketPricePoint writer drops the read cache (#3126)', () => {
    /*
     * The shared collector, not a hand-rolled `git ls-files` —
     * `file-collection-is-not-silently-empty` refuses a new one, and rightly:
     * this carries the FLOOR, so a renamed root fails loudly instead of
     * scanning nothing and reporting a clean sweep.
     *
     * One caveat it cannot remove, because it is `git ls-files` underneath:
     * AN UNSTAGED NEW FILE IS INVISIBLE. Proving a new writer is covered has
     * to happen after staging it.
     */
    const files = collectTrackedFiles({
        roots: ['src'],
        extensions: ['.ts'],
        floor: 500,
    }).filter((f) => !f.includes('/__tests__/'));

    const writers = files.filter((f) => POINT_WRITE.test(code(f)));

    it('prints its denominator', () => {
        // eslint-disable-next-line no-console
        console.log(
            `[price-writers] ${files.length} src file(s); ${writers.length} write ` +
                `MarketPricePoint; ${Object.keys(EXEMPT).length} exempt`,
        );
        // A FLOOR. The guard is useless over an empty population, and a
        // renamed model or a moved root would silently empty it — which is the
        // `an-empty-window-passes-a-negated-assertion` shape.
        // `collectTrackedFiles` carries the file floor; this one is about the
        // WRITER population, which the collector cannot know about.
        expect(writers.length).toBeGreaterThanOrEqual(4);
    });

    it('every writing FUNCTION invalidates — not merely every file', () => {
        /*
         * PER FUNCTION, and a mutation is why.
         *
         * The first version asked "does this FILE invalidate anywhere", and a
         * mutation removing `clearOverride`'s call SURVIVED: the file still
         * held `upsertOverrideDay`'s, so the guard passed while the worse of
         * the two paths had silently lost it. `clearOverride` exists to undo a
         * wrong price, so a cache that keeps serving the overridden figure
         * makes the one corrective action appear to do nothing.
         *
         * `a-gate-narrow-enough-to-always-pass`, one level down: the gate was
         * named correctly and scoped to the wrong unit.
         */
        const missing: string[] = [];
        for (const file of writers) {
            const rel = relative(ROOT, file);
            if (rel in EXEMPT) continue;
            for (const fn of exportedFunctions(code(file))) {
                if (!POINT_WRITE.test(fn.body)) continue;
                if (!INVALIDATES.test(fn.body)) missing.push(`${rel} :: ${fn.name}`);
            }
        }
        expect(missing).toEqual([]);
    });

    it('lists no EXEMPT entry that is not a writer any more', () => {
        // The no-stale-entries half. An exemption outliving its file keeps that
        // PATH pre-approved for whatever is created there next — #1285's
        // defect, where four `require('@/env')` entries outlived the usecases
        // the GRC teardown deleted.
        const rels = new Set(writers.map((f) => relative(ROOT, f)));
        for (const file of Object.keys(EXEMPT)) {
            expect(rels.has(file)).toBe(true);
        }
    });

    it('the extractor finds real functions with non-empty bodies', () => {
        // THE CONTROL. An extractor returning nothing, or empty bodies, makes
        // the per-function assertion above vacuous — every writing function
        // would be invisible and the guard would pass over no work at all.
        for (const file of writers) {
            const fns = exportedFunctions(code(file));
            expect(fns.length).toBeGreaterThan(0);
            // Not merely non-empty: a body that is `{ a: string }` is a
            // return TYPE mistaken for a body, which is what this caught.
            for (const fn of fns) expect(fn.body.length).toBeGreaterThan(40);
        }
        // And it really does separate siblings in ONE file: the overrides
        // module has both a write path and a withdrawal path, and each must be
        // seen on its own.
        const overrides = code(`${ROOT}/src/app-layer/usecases/market-price-overrides.ts`);
        const names = exportedFunctions(overrides).map((f) => f.name);
        expect(names).toContain('upsertOverrideDay');
        expect(names).toContain('clearOverride');
    });

    it('its detector fires on a writer and NOT on a reader', () => {
        // The population is a SUBSET, and a detector that matched reads too
        // would pull in every file that merely queries prices — making the
        // guard noisy and, worse, making its denominator meaningless.
        expect(POINT_WRITE.test('await db.marketPricePoint.upsert({')).toBe(true);
        expect(POINT_WRITE.test('await prisma.marketPricePoint.createMany({')).toBe(true);
        expect(POINT_WRITE.test('await db.marketPricePoint.updateMany({')).toBe(true);
        expect(POINT_WRITE.test('await db.marketPricePoint.findMany({')).toBe(false);
        expect(POINT_WRITE.test('await db.marketPricePoint.count({')).toBe(false);
        expect(POINT_WRITE.test('marketPriceSeries.upsert({')).toBe(false);
    });

    it('a COMMENT about invalidating does not satisfy it', () => {
        // `a-scar-is-not-a-wound`: a comment hit usually means the pattern was
        // REMOVED. A file explaining the rule while not obeying it must fail.
        const commented = blankNonCode(
            'await db.marketPricePoint.upsert({});\n// call invalidatePriceTrendsCache here\n',
            { strings: false },
        );
        expect(POINT_WRITE.test(commented)).toBe(true);
        expect(INVALIDATES.test(commented)).toBe(false);
    });
});
