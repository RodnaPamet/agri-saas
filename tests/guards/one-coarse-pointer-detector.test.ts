/**
 * ONE coarse-pointer detector, and the narrower query is a separate decision
 * (#2828).
 *
 * There were three answers to "is this a touch device" and they were not all
 * the same question:
 *
 * | consumer | before | query |
 * |---|---|---|
 * | `tooltip.tsx` | a module-private `useCoarsePointer` | `(hover: none), (pointer: coarse)` |
 * | `use-long-press.ts` | a byte-for-byte copy of it | the same |
 * | `<SwipeRow>` | `useMediaQuery().isMobile` | a `min-width` probe |
 *
 * The risk was never the query string drifting. It is the next consumer
 * importing whichever copy it happens to find, and a later fix landing on only
 * one of them — and `<SwipeRow>` is what that looks like after the fact: its
 * own docblock argued for a coarse pointer while the code asked about width,
 * so a desktop window narrowed to phone width rendered the swipe wrapper and a
 * LARGE TABLET got none.
 *
 * ## The population, and what it may NOT contain
 *
 * Every `.ts`/`.tsx` under `src/` is scanned with comments blanked, because a
 * query string named in a docblock is not a detector (#1774 — and three files
 * here mention these queries in prose only). Exactly one module may ASK them.
 *
 * ## `(pointer: coarse)` ALONE is a different policy, deliberately
 *
 * #2828's table called all the copies identical. Measured, they are two:
 * `usePullToRefresh` and `src/lib/view-transitions` check `(pointer: coarse)`
 * with no `(hover: none)` arm, one-shot, inside an effect or a predicate.
 * That is NARROWER — it excludes a no-hover device reporting a fine pointer, a
 * stylus tablet — and it answers a different question: "attach this gesture /
 * run this transition on this device right now" rather than "render a touch
 * affordance". Folding them in would WIDEN both, which is a behaviour change
 * nobody asked for, so they are recorded here with that reason rather than
 * migrated.
 */
import { readFileSync } from 'fs';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles } from '../helpers/collect-files';

/** The ONE module allowed to ask the OR query. */
const DETECTOR = 'src/components/ui/hooks/use-coarse-pointer.ts';

/**
 * Files that may ask `(pointer: coarse)` WITHOUT the `(hover: none)` arm.
 *
 * Each is one-shot and imperative — not a subscribed hook — and each would
 * change behaviour if migrated. An entry is a decision; §3 fails when one
 * names a file that no longer asks anything.
 */
const NARROW_QUERY_ALLOWED: Record<string, string> = {
    'src/components/ui/hooks/use-pull-to-refresh.tsx':
        'Decides whether to ATTACH the pull gesture, once, inside an effect. A mouse user has never expected to drag a page down to refresh, and the narrower query is what keeps a stylus tablet — no hover, fine pointer — out of a gesture its user cannot perform comfortably.',
    'src/lib/view-transitions/index.tsx':
        'A one-shot eligibility predicate for `document.startViewTransition`, beside a `prefers-reduced-motion` check. It gates an ANIMATION rather than an affordance, so widening it to no-hover devices would start animating navigations on hardware nobody has measured it on.',
};

const OR_QUERY = /\(\s*hover:\s*none\s*\)/;
const COARSE_QUERY = /\(\s*pointer:\s*coarse\s*\)/;

/**
 * A string literal that is ENTIRELY a pointer media query.
 *
 * The first draft tested the query pattern against the whole file and reported
 * `filter/filter-list.tsx`, which carries
 * `[@media(hover:none)]:hover:bg-transparent` — a Tailwind arbitrary variant
 * inside a `className`. That is CSS doing exactly the right thing, and a guard
 * that calls it a second detector is reporting the fix as the defect.
 *
 * So the subject is a literal whose WHOLE value is such a query. That catches
 * every real asker (`'(pointer: coarse)'`, `'(hover: none), (pointer:
 * coarse)'`, including the detector's exported constant, which a
 * `matchMedia(...)`-scoped scan would MISS because the call takes the constant
 * rather than a literal) and no className.
 */
const WHOLE_QUERY = /^\s*\(\s*(?:hover:\s*none|pointer:\s*coarse)\s*\)(?:\s*,\s*\(\s*(?:hover:\s*none|pointer:\s*coarse)\s*\))*\s*$/;

/** Every single/double/backtick string literal in a source file. */
function stringLiterals(code: string): string[] {
    return [...code.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`/g)]
        .map((m) => m[1] ?? m[2] ?? m[3] ?? '');
}

interface Asker {
    readonly file: string;
    readonly or: boolean;
    readonly coarse: boolean;
}

function askers(): Asker[] {
    const out: Asker[] = [];
    for (const abs of collectSourceFiles({ roots: ['src'] })) {
        const raw = readFileSync(abs, 'utf8');
        if (!OR_QUERY.test(raw) && !COARSE_QUERY.test(raw)) continue;
        // Comments blanked: three files in this population name these queries
        // in prose only, and a guard that counted those would report the
        // explanation as the violation.
        const code = blankNonCode(raw, { strings: false });
        const queries = stringLiterals(code).filter((l) => WHOLE_QUERY.test(l));
        if (queries.length === 0) continue;
        const or = queries.some((q) => OR_QUERY.test(q));
        const coarse = queries.some((q) => COARSE_QUERY.test(q));
        const file = abs.slice(abs.indexOf('src/'));
        out.push({ file, or, coarse });
    }
    return out;
}

describe('one coarse-pointer detector (#2828)', () => {
    const found = askers();

    it('§0 the detector itself asks the query — the positive control', () => {
        // Without this, "nobody else asks it" is satisfied by a repo where
        // NOBODY asks it, which is what a renamed hook or a changed query
        // string would produce. The floor is the same idea one level up.
        const detector = found.find((f) => f.file === DETECTOR);
        expect(detector).toBeDefined();
        expect(detector!.or).toBe(true);
        expect(found.length).toBeGreaterThanOrEqual(3);
    });

    it('§1 reports its denominator', () => {
        console.log(
            `[one-coarse-pointer] ${found.length} file(s) ask a pointer query in CODE: `
            + `1 detector, ${Object.keys(NARROW_QUERY_ALLOWED).length} recorded narrow-query `
            + `site(s), ${found.length - 1 - Object.keys(NARROW_QUERY_ALLOWED).length} other`,
        );
    });

    it('§2 only the detector asks the OR query', () => {
        const others = found.filter((f) => f.or && f.file !== DETECTOR).map((f) => f.file);
        expect(others).toEqual([]);
    });

    it('§3 every narrow-query site is recorded, and no record is stale', () => {
        const narrow = found.filter((f) => !f.or && f.coarse && f.file !== DETECTOR);
        const unrecorded = narrow.map((f) => f.file).filter((f) => !(f in NARROW_QUERY_ALLOWED));
        expect(unrecorded).toEqual([]);

        // An entry is COVER, so it expires: one naming a file that no longer
        // asks anything keeps that cover alive for whatever is written there
        // next (#1285).
        const asking = new Set(narrow.map((f) => f.file));
        const stale = Object.keys(NARROW_QUERY_ALLOWED).filter((f) => !asking.has(f));
        expect(stale).toEqual([]);

        for (const why of Object.values(NARROW_QUERY_ALLOWED)) {
            expect(why.length).toBeGreaterThan(100);
        }
    });

    it('§4 the three migrated consumers import the hook rather than asking', () => {
        // Named rather than derived, because these three ARE the issue. A
        // derived check would pass the moment a consumer stopped importing
        // anything at all — which is how `<SwipeRow>` asked the wrong question
        // for months while every guard was green.
        for (const file of [
            'src/components/ui/tooltip.tsx',
            'src/components/ui/hooks/use-long-press.ts',
            'src/components/ui/swipe-row.tsx',
        ]) {
            const code = blankNonCode(readFileSync(file, 'utf8'), { strings: false });
            expect(code).toMatch(/\buseCoarsePointer\b/);
            expect(stringLiterals(code).filter((l) => WHOLE_QUERY.test(l))).toEqual([]);
        }
        // And `<SwipeRow>` specifically must NOT be back on the width probe:
        // that is the defect this phase corrected, and it is invisible — the
        // component still renders, just on the wrong devices.
        const swipe = blankNonCode(
            readFileSync('src/components/ui/swipe-row.tsx', 'utf8'),
            { strings: false },
        );
        expect(swipe).not.toMatch(/useMediaQuery/);
    });
});
