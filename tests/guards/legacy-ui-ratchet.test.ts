/**
 * Epic 51 — legacy UI class-usage ratchet.
 *
 * Epic 51 ported CVA-based `<Button>` / `<StatusBadge>` / `<EmptyState>`
 * primitives and token-bridged the legacy `.btn` / `.badge` CSS classes so
 * both surfaces now share one palette. Full component replacement across
 * every `className="btn btn-primary"` call site is a gradual rollout — this
 * ratchet prevents the count from *growing* while that migration proceeds.
 *
 * Rules:
 *   - The baseline is recorded below and may only be lowered.
 *   - Adding a new `className="btn btn-primary"` instance fails CI; migrate
 *     to `<Button variant="primary">` or consciously lower the baseline
 *     along with the new usage.
 *
 * Scoped to `src/app/t/` (application pages). Component-layer files are
 * excluded — they define the baseline look that the CSS class system is
 * built on and shouldn't count toward the ratchet.
 */

import * as fs from 'fs';
import * as path from 'path';

import { blankNonCode } from '../helpers/blank-non-code';

const APP_PAGES_ROOT = path.resolve(__dirname, '../../src/app/t');

/**
 * Ratcheted baselines. Lower these numbers when you migrate usages to
 * `<Button>` / `<StatusBadge>` / `<EmptyState>`. Never raise them.
 *
 * Recorded at the Epic 51 remediation pass. Full migration target is 0 for
 * each — planned as a separate rollout after the visual QA of `<Button>`.
 */
const BASELINES = {
    // 242 → 245 with Epic 49 (compliance calendar): three new
    // `btn btn-ghost btn-sm` chevron-nav buttons in CalendarClient
    // (prev/next month) + `btn btn-secondary btn-sm` in error states.
    // 245 → 246 when audits/readiness empty state was inlined (server
    // component can't pass forwardRef icons to <EmptyState>; the
    // inlined version uses one `btn btn-primary` for "+ New Audit
    // Cycle").
    // 246 → 251 with Epic G-3: vendor questionnaire builder (admin/
    // vendor-templates index + builder pages) + reviewer page
    // (admin/vendor-assessment-reviews/[id]) match the rest of the
    // admin surface's `btn btn-*` shape. Slot into the existing
    // legacy-btn migration backlog alongside the other admin pages.
    // 251 → 0 with the .btn → <Button> migration on main (#8bcf699,
    // 2026-05-08). The remaining `btn` substring matches in app pages
    // are now all `id="*-btn"` attributes (not className tokens), and
    // those don't match this test's regex which is anchored to
    // `className="..."` strings.
    btn: 0,
    // 78 → 0 with the PR-2 .badge → <StatusBadge> migration. New
    // dedicated eradication ratchet at
    // `tests/guards/legacy-badge-eradication.test.ts` is the
    // authoritative gate going forward; this baseline is kept at 0
    // as a defence-in-depth against accidental reintroduction with
    // an inline `className="badge ..."` string.
    badge: 0,
} as const;

function walk(dir: string, out: string[]): string[] {
    // Named throw, so a renamed root fails loudly instead of yielding an empty
    // population that every assertion below accepts (#875, #2407).
    if (!fs.existsSync(dir)) {
        throw new Error(`legacy-ui-ratchet: scan root does not exist: ${dir}`);
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full, out);
        } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

const SOURCES = walk(APP_PAGES_ROOT, []).map((p) => ({
    file: path.relative(APP_PAGES_ROOT, p),
    src: blankNonCode(fs.readFileSync(p, 'utf-8')),
}));

interface CountSource {
    file: string;
    src: string;
}

/**
 * Takes its sources as a PARAMETER, so the control below can hand it input the
 * repo does not contain.
 *
 * `scripts/selector-teeth.mjs` reported this gutted to `return 0` and
 * SURVIVING, and the reason is specific: both baselines are **0**, so
 * `expect(actual).toBeLessThanOrEqual(0)` passes whether the counter works or
 * always answers zero. The ratchet could not tell "no legacy classes remain"
 * from "the counter is broken" — and it is the former that it exists to
 * certify.
 *
 * Closing over the module-level `SOURCES` made that untestable: the repo has
 * zero `className="btn …"` by design, so there was no input that could
 * distinguish the two answers.
 */
function countClassToken(token: 'btn' | 'badge', sources: readonly CountSource[] = SOURCES): number {
    // Match `className="..."` where a whole-word `token` appears among the
    // class names.
    //
    // `\bbtn\b` excludes `button-xyz` — `button` has no word boundary after
    // `btn` — but it does NOT exclude `btn-primary`: a hyphen IS a word
    // boundary, so the `btn` in `btn-primary` matches. This comment used to
    // claim the opposite, naming `btn-primary` as a false positive it avoided.
    // Measured 2026-10-27: `className="btn-primary"` counts 1.
    //
    // The behaviour is the stricter of the two and is left as it is — with
    // both baselines at 0, any occurrence fails either way, and the legacy
    // idiom was `btn btn-primary` together so a bare `btn-primary` is a
    // legacy class too. Only the claim was wrong.
    const re = new RegExp(`className=["'\`][^"'\`]*\\b${token}\\b[^"'\`]*["'\`]`, 'g');
    let total = 0;
    for (const { src } of sources) {
        const matches = src.match(re);
        if (matches) total += matches.length;
    }
    return total;
}

describe('Legacy UI class ratchet — Epic 51 rollout guard', () => {
    it('[legacy-ui] the counter can actually count — the control', () => {
        // Both baselines are 0, so `toBeLessThanOrEqual(BASELINES.x)` passes
        // for a counter that always answers zero. This is what makes the
        // difference between "no legacy classes remain" and "the counter is
        // broken" observable at all (#2407).
        //
        // Synthetic input, because the repo deliberately contains no
        // `className="btn …"`. That is the whole point of the ratchet, and it
        // is also why no real file can serve as the control.
        expect(countClassToken('btn', [{ file: 'x.tsx', src: '<div className="btn foo">' }])).toBe(1);
        expect(countClassToken('badge', [{ file: 'x.tsx', src: '<span className="a badge">' }])).toBe(1);
        // Two in one file are two, so the ratchet moves per OCCURRENCE rather
        // than per file — which is what its baseline counts.
        expect(
            countClassToken('btn', [
                { file: 'x.tsx', src: '<a className="btn">1</a><a className="btn x">2</a>' },
            ]),
        ).toBe(2);
    });

    it('[legacy-ui] the counter does NOT count near misses', () => {
        // The other direction. A counter that matched everything would pass
        // the control above while making the baseline unclearable.
        for (const src of [
            '<div className="button foo">',   // `button` has no boundary after btn
            '<div data-x="btn">',             // not a className attribute
            '<div className="xbtn">',         // no boundary before btn
        ]) {
            expect({ src, count: countClassToken('btn', [{ file: 'x.tsx', src }]) })
                .toEqual({ src, count: 0 });
        }
    });

    it('[legacy-ui] a hyphenated legacy class DOES count, contrary to the old comment', () => {
        // Pinned because the function's docblock asserted the opposite until
        // 2026-10-27: it named `btn-primary` as a false positive that
        // `\bbtn\b` avoided. A hyphen is a word boundary, so it never did.
        //
        // The behaviour is correct — the legacy idiom was `btn btn-primary`
        // together, so a bare `btn-primary` is a legacy class — and with both
        // baselines at 0 it fails either way. It is pinned so the comment and
        // the regex cannot drift apart again.
        expect(countClassToken('btn', [{ file: 'x.tsx', src: '<div className="btn-primary">' }])).toBe(1);
    });

    it('[legacy-ui] comments are blanked UPSTREAM, not by the counter', () => {
        // Worth stating because my first version of the control above asserted
        // that a commented-out className counts 0, and it does not: the
        // counter is handed already-blanked source, so passing it a raw
        // comment bypasses the blanking entirely. The protection is real but
        // lives in SOURCES, one level up.
        const raw = '// className="btn" in a comment';
        expect(countClassToken('btn', [{ file: 'x.tsx', src: raw }])).toBe(1);
        expect(countClassToken('btn', [{ file: 'x.tsx', src: blankNonCode(raw) }])).toBe(0);
    });

    it('[legacy-ui] the scan reaches a real population — the denominator', () => {
        // `walk` is the other selector the audit reported dead. With both
        // baselines at 0 an empty SOURCES satisfies every assertion below, so
        // the population needs its own floor.
        console.log(`[legacy-ui] ${SOURCES.length} .ts/.tsx file(s) under the app pages root`);
        expect(SOURCES.length).toBeGreaterThan(100);
    });

    it('count of `className="btn …"` usages does not grow beyond the baseline', () => {
        const actual = countClassToken('btn');
        expect(actual).toBeLessThanOrEqual(BASELINES.btn);
    });

    it('count of `className="badge …"` usages does not grow beyond the baseline', () => {
        const actual = countClassToken('badge');
        expect(actual).toBeLessThanOrEqual(BASELINES.badge);
    });

    it('baseline constants are non-negative integers', () => {
        // Both surfaces drove their baselines to 0 after the .btn / .badge
        // migrations on main. Guard against accidental negation of the
        // ratchet in a future PR.
        expect(BASELINES.btn).toBeGreaterThanOrEqual(0);
        expect(BASELINES.badge).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(BASELINES.btn)).toBe(true);
        expect(Number.isInteger(BASELINES.badge)).toBe(true);
    });
});
