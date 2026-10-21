/**
 * A rendered test that reaches a viewport-SWITCHING primitive says which
 * device it means — on a shrink-only ceiling (#2134).
 *
 * ## The mechanism
 *
 * jsdom's `matchMedia` stub answers `matches: false` to every query, so a
 * rendered test that never sets a viewport runs MOBILE. Four UI primitives
 * switch IMPLEMENTATION on that query rather than just classes:
 *
 *     ui/modal.tsx             Radix Dialog  / Vaul Drawer
 *     ui/popover.tsx           Radix Popover / Vaul Drawer
 *     ui/sheet.tsx             right-directional Drawer / bottom Drawer
 *     ui/DeferredOnMobile.tsx  renders / defers
 *
 * So such a test does not exercise "the component at an unspecified size". It
 * exercises the mobile component tree, and the desktop one is a different tree.
 * `tests/rendered/modal.test.tsx` has known this since Epic 56 and works
 * around it per-case with a `desktopOnly` prop; nothing said which other
 * suites needed the same.
 *
 * It bit twice in #1995, both found by hand: the notifications bell's popover
 * had ONLY ever rendered as a Vaul drawer, and `exchange-client` had no
 * viewport call at all while `ExchangeClient` branches on it in four places.
 *
 * ## Why a CEILING and not a requirement
 *
 * Measured 2026-10-22 by the import walk below: **106 of 265** files in
 * `tests/rendered` transitively reach one of those four, and **81** of them
 * never say which device they mean. Requiring a desktop pass for all 82 is the kind of
 * sweeping demand that gets a guard muted — most of that 82 is a component
 * with no viewport-dependent behaviour, where a second pass is cost without
 * signal.
 *
 * So the existing population is grandfathered collectively and this number can
 * only FALL. What it stops is the 83rd — a NEW rendered test that reaches a
 * switching primitive and says nothing about device — which is what makes the
 * conversion finite. Same shape as `guards-blank-comments-before-matching`,
 * which caps unblanked source reads for the same reason.
 *
 * ## Three ways to be counted as handled
 *
 *   1. reach desktop — `setViewport('desktop')`, a `setViewport(viewport)`
 *      parametrisation, or a case list whose table carries `'desktop'`;
 *   2. force the desktop presentation directly — either the `desktopOnly`
 *      prop `modal.test.tsx` uses, or a `useMediaQuery` mock returning
 *      `device: 'desktop'`, which four suites do and which bypasses
 *      `matchMedia` altogether;
 *   3. say mobile is deliberate — `mobileOnly('…')` from `./viewport`, which
 *      takes a reason and sets the viewport explicitly.
 *
 * (3) is the cheap one and the point of the whole exercise: it makes "mobile
 * by decision" distinguishable from "nobody thought about it".
 *
 * ## The count moved while this was being written, twice
 *
 * A first exploratory sweep said 82 and the guard's own detector said 85,
 * because the sweep counted a bare `'desktop'` ANYWHERE as handled. Reading
 * the five files they disagreed on found mechanisms (2) and (1) above that
 * nothing had modelled — `useMediaQuery` mocks, and a `['desktop', 1280]`
 * tuple. So the exploratory number was right by accident and for the wrong
 * reason, and the strict number was wrong by being too strict. The figure
 * below is the one measured after both were modelled, and #2134 should be
 * read as superseded on this point: it called `mobile-forms.test.tsx`
 * deliberately mobile-only, and that file mocks `useMediaQuery` to desktop.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { collectSourceFiles } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
const RENDERED = path.join(ROOT, 'tests/rendered');

/** Primitives whose IMPLEMENTATION depends on the media query. */
const SWITCHERS = [
    'src/components/ui/modal.tsx',
    'src/components/ui/popover.tsx',
    'src/components/ui/sheet.tsx',
    'src/components/ui/DeferredOnMobile.tsx',
].map((r) => path.join(ROOT, r));

/**
 * Shrink-only. Lower it in the same diff as the conversion; raising it needs a
 * dated reason and a new entry here saying why that suite cannot say which
 * device it means.
 *
 * 81 — measured 2026-10-22, #2134. Set to the live count, not above it, so
 * the ceiling has no slack to absorb the next addition silently.
 */
const UNSPECIFIED_CEILING = 81;

/** Resolve an import specifier to a file on disk, or null if not ours. */
function resolveSpec(from: string, spec: string): string | null {
    let base: string;
    if (spec.startsWith('@/')) base = path.join(ROOT, 'src', spec.slice(2));
    else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
    else return null; // a package — never reaches our primitives
    for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
        const p = base + ext;
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    }
    return null;
}

const importCache = new Map<string, string[]>();
function importsOf(file: string): string[] {
    const hit = importCache.get(file);
    if (hit) return hit;
    let out: string[] = [];
    try {
        // Comments blanked, strings KEPT: the specifier lives in a string, so
        // `strings: true` would blank the thing being parsed. A commented-out
        // import would otherwise add an edge to the graph and make a suite
        // "reach a switcher" it does not — the direction that demands a
        // conversion nobody needs.
        const src = blankNonCode(fs.readFileSync(file, 'utf8'));
        out = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)]
            .map((m) => resolveSpec(file, m[1]))
            .filter((p): p is string => p !== null);
    } catch {
        out = [];
    }
    importCache.set(file, out);
    return out;
}

/** Does any import path from `start` reach a switching primitive? */
function reachesSwitcher(start: string[]): boolean {
    const seen = new Set<string>();
    const queue = [...start];
    while (queue.length > 0) {
        const file = queue.pop()!;
        if (seen.has(file)) continue;
        seen.add(file);
        if (SWITCHERS.includes(file)) return true;
        for (const next of importsOf(file)) if (!seen.has(next)) queue.push(next);
    }
    return false;
}

/**
 * Does this suite say which device it means?
 *
 * Comments are blanked first. A first version read raw text and argued that a
 * comment mentioning `setViewport('desktop')` counting as handled was the safer
 * error — it lets one suite through rather than demanding work. That had the
 * direction backwards: a comment is not a mechanism, so counting it IS the
 * false claim, and `guards-blank-comments-before-matching` caps unblanked
 * source reads precisely to stop a 458th one being added on that reasoning.
 *
 * Strings are kept, because every mechanism below IS a string or a prop name.
 */
function saysWhichDevice(src: string): boolean {
    return (
        /setViewport\(\s*'desktop'\s*\)/.test(src) ||
        /setViewport\(\s*viewport\s*\)/.test(src) ||
        // A case table carrying desktop, alone (`['desktop']`) or as the
        // first element of a tuple (`['desktop', 1280]`).
        /\[\s*'desktop'/.test(src) ||
        /desktopOnly/.test(src) ||
        // A `useMediaQuery` mock answering desktop. More direct than
        // `setViewport` — it replaces the hook rather than the query it
        // reads — and four suites take this route.
        /device:\s*'desktop'/.test(src) ||
        /mobileOnly\(/.test(src)
    );
}

interface Suite {
    file: string;
    reaches: boolean;
    says: boolean;
}

function surveyRendered(): Suite[] {
    const files = collectSourceFiles({
        roots: ['tests/rendered'],
        extensions: ['.test.tsx'],
        floor: 200,
    });
    return files.map((file) => {
        const src = fs.readFileSync(file, 'utf8');
        return {
            file: path.relative(ROOT, file),
            reaches: reachesSwitcher(importsOf(file)),
            says: saysWhichDevice(blankNonCode(src)),
        };
    });
}

describe('rendered tests that reach a viewport switcher', () => {
    const SUITES = surveyRendered();
    const unspecified = SUITES.filter((s) => s.reaches && !s.says);

    it('surveyed a real population, and the walk actually reaches things', () => {
        // Four assertions because three of them can go vacuous
        // independently: an empty directory, an import resolver that returns
        // nothing, and a `SWITCHERS` list whose paths have been renamed.
        expect(SUITES.length).toBeGreaterThanOrEqual(200);
        expect(SUITES.filter((s) => s.reaches).length).toBeGreaterThanOrEqual(50);
        expect(SUITES.filter((s) => s.says).length).toBeGreaterThanOrEqual(10);
        for (const s of SWITCHERS) expect(fs.existsSync(s)).toBe(true);
    });

    it(`at most ${UNSPECIFIED_CEILING} suites reach a switcher without saying which device`, () => {
        if (unspecified.length > UNSPECIFIED_CEILING) {
            throw new Error(
                `${unspecified.length} rendered suites reach a viewport-switching ` +
                    `primitive and never say which device they mean (ceiling ` +
                    `${UNSPECIFIED_CEILING}).\n\n` +
                    `jsdom's matchMedia stub answers false to everything, so these run ` +
                    `MOBILE — and modal/popover/sheet/DeferredOnMobile switch ` +
                    `IMPLEMENTATION on that query, so the desktop tree is untested.\n\n` +
                    `Three ways to fix the new one:\n` +
                    `  · setViewport('desktop'), or parametrise over both;\n` +
                    `  · render with the desktopOnly prop, as modal.test.tsx does;\n` +
                    `  · mobileOnly('<why desktop is out of scope>') from ./viewport.\n\n` +
                    `Newest first:\n` +
                    unspecified.slice(-8).map((s) => `  ${s.file}`).join('\n'),
            );
        }
        expect(unspecified.length).toBeLessThanOrEqual(UNSPECIFIED_CEILING);
    });

    it('the ceiling is not stale by more than the conversions done', () => {
        // A ceiling above the live count has slack to absorb the next
        // addition silently, which is the whole failure mode of a ratchet. It
        // is set AT the live count, so a conversion run has to lower it rather
        // than bank the difference.
        expect(UNSPECIFIED_CEILING - unspecified.length).toBeLessThanOrEqual(0);
    });

    it('CONTROL: the import walk finds a switcher through an INTERMEDIATE file', () => {
        // The whole point over a direct-import grep, which the issue measured
        // at 8 files where the real number is 106. `notifications-bell.tsx`
        // imports `ui/popover` directly; a page component that renders the
        // bell reaches it at depth 2.
        const bell = path.join(ROOT, 'src/components/layout/notifications-bell.tsx');
        expect(fs.existsSync(bell)).toBe(true);
        expect(reachesSwitcher([bell])).toBe(true);
        // And something that genuinely cannot reach one.
        const pure = path.join(ROOT, 'src/lib/exchange/currency.ts');
        expect(fs.existsSync(pure)).toBe(true);
        expect(reachesSwitcher([pure])).toBe(false);
    });

    it('CONTROL: saysWhichDevice recognises each of the three mechanisms', () => {
        expect(saysWhichDevice("setViewport('desktop');")).toBe(true);
        expect(saysWhichDevice("describe.each([['mobile'],['desktop']])")).toBe(true);
        // The tuple form, which the first version of this detector missed and
        // `public-profile-editor.test.tsx` uses.
        expect(saysWhichDevice("it.each([['desktop', 1280], ['mobile', 390]])")).toBe(true);
        expect(saysWhichDevice('render(<ModalHarness desktopOnly />)')).toBe(true);
        // The hook mock, which four suites use and which nothing had modelled.
        expect(saysWhichDevice("useMediaQuery: () => ({ device: 'desktop', isMobile: false })")).toBe(
            true,
        );
        expect(saysWhichDevice("mobileOnly('the drawer IS the subject here')")).toBe(true);
        expect(saysWhichDevice("setViewport('mobile');")).toBe(false);
        expect(saysWhichDevice('render(<Thing />)')).toBe(false);
        // Double quotes are NOT matched, and that is a known limit rather
        // than an oversight: this repo's rendered tests use single quotes
        // throughout, and widening the pattern would start matching prose.
        expect(saysWhichDevice('describe.each([["mobile"],["desktop"]])')).toBe(false);
    });
});
