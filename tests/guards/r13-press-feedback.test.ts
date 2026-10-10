/**
 * Roadmap-13 PR-8 — Press feedback (the one allowed transform).
 *
 * The R12 motion-language rule was "opacity + colour only — no
 * transform / scale / translate". R13-PR8 consciously broadens
 * that rule by one element: the row drops 1px on mousedown
 * (`active:translate-y-px`), the universal "you just pressed
 * something physical" cue.
 *
 * Why this single broadening is worth the cost:
 *
 *   - Every R12 lift / hover-scale was banned because it composed
 *     poorly with the band + label motion language. The mousedown
 *     press is a transient (~50ms) micro-motion, not a sustained
 *     hover lift — it doesn't interfere with the band's 200ms
 *     opacity transition or the shimmer's 4s pulse.
 *
 *   - The user explicitly asked for "more clickable, more
 *     inevitable" buttons. Inset shadow (PR-7) gives static
 *     concavity; the press gives the transient click reward.
 *     Without the press, the row feels glossy but inert — the
 *     same fingertip that pressed a Mac button or an iOS row
 *     expects this feedback.
 *
 *   - Restricted to `active:` (CSS `:active`) — fires only during
 *     mousedown. `hover:translate-*` is still banned by the
 *     global motion-language ratchet for everyone except this
 *     file.
 *
 * Three pieces, each invariant-checked here:
 *
 *   1. `active:translate-y-px` is wired in NAV_ITEM_BASE.
 *   2. `motion-reduce:active:translate-y-0` is the OS-preference
 *      safety net.
 *   3. `transition-transform duration-75 ease-out` makes the
 *      down-press snappy.
 *
 * Also locks the motion-language exempt: nav-item.tsx is the 6th
 * exempt file. The exempt count is bumped from 5 → 6 in the same
 * diff; the comment in motion-language-discipline.test.ts
 * documents the broadening rationale.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
const NAV_ITEM_SRC = fs.readFileSync(
    path.join(ROOT, 'src/components/layout/nav-item.tsx'),
    'utf8',
);
const MOTION_GUARD_SRC = fs.readFileSync(
    path.join(ROOT, 'tests/guards/motion-language-discipline.test.ts'),
    'utf8',
);

describe('Roadmap-13 PR-8 — press feedback (the one allowed transform)', () => {
    describe('NAV_ITEM_BASE wires the press', () => {
        it('includes `active:translate-y-px`', () => {
            // The 1px mousedown drop. `y-px` is exactly 1 CSS pixel
            // — the standard "I pressed it" displacement on macOS,
            // iOS, and every premium web button design. 2px would
            // feel mushy; 0.5px would be invisible.
            const baseRegion =
                NAV_ITEM_SRC.match(
                    /export\s+const\s+NAV_ITEM_BASE\s*=\s*\[[\s\S]+?\]\.join\(/,
                )?.[0] ?? '';
            expect(baseRegion).toMatch(/active:translate-y-px/);
        });

        it('includes the motion-reduce override `motion-reduce:active:translate-y-0`', () => {
            // OS-level reduced-motion users get NO displacement.
            // The token-css global override flattens animation
            // duration to 1ms but does NOT cancel a translate
            // (translate is a static transform, not an animation).
            // The explicit `motion-reduce:active:translate-y-0`
            // is required to cancel the press for these users.
            const baseRegion =
                NAV_ITEM_SRC.match(
                    /export\s+const\s+NAV_ITEM_BASE\s*=\s*\[[\s\S]+?\]\.join\(/,
                )?.[0] ?? '';
            expect(baseRegion).toMatch(
                /motion-reduce:active:translate-y-0/,
            );
        });

        it('includes `transition-transform duration-75 ease-out`', () => {
            // The press needs a transform transition so the down-
            // press doesn't snap-jump. 75ms is the snappy tempo —
            // fast enough to feel immediate, long enough to read
            // as motion rather than teleport.
            const baseRegion =
                NAV_ITEM_SRC.match(
                    /export\s+const\s+NAV_ITEM_BASE\s*=\s*\[[\s\S]+?\]\.join\(/,
                )?.[0] ?? '';
            expect(baseRegion).toMatch(/transition-transform/);
            expect(baseRegion).toMatch(/duration-75/);
        });
    });

    describe('the broadening is restricted to active: only', () => {
        // Strip block + line comments so the assertions only see
        // executable code. Doc-comments routinely mention banned
        // patterns ("a future hover:scale-110 PR would …") and
        // shouldn't trip the structural scan.
        const stripped = blankNonCode(NAV_ITEM_SRC);

        it('no `hover:translate-*` in nav-item.tsx executable code', () => {
            // The R12 ban on hover-translate stays in place even
            // inside the exempt file. The broadening is narrowly
            // scoped to `active:` — mousedown only.
            expect(stripped).not.toMatch(/\bhover:translate-/);
            expect(stripped).not.toMatch(/\bhover:-translate-/);
        });

        it('no `hover:scale-*` in nav-item.tsx executable code', () => {
            // Same — hover-scale is decorative lift and stays banned.
            expect(stripped).not.toMatch(/\bhover:scale-/);
        });

        it('no `focus-visible:translate-*` (keyboard users get NO motion)', () => {
            // Keyboard users navigate by Tab; an unprompted
            // displacement when focus lands on the row would be
            // disorienting. Focus stays at the static position
            // — the focus-ring is the entire feedback.
            expect(stripped).not.toMatch(/\bfocus-visible:translate-/);
        });
    });

    describe('motion-language-discipline ratchet is updated in this diff', () => {
        it('nav-item.tsx is in EXEMPT_FILES', () => {
            // The ratchet lives at
            // `tests/guards/motion-language-discipline.test.ts`.
            // PR-8 adds nav-item.tsx to its exempt list with the
            // documented broadening rationale.
            expect(MOTION_GUARD_SRC).toMatch(
                /['"]src\/components\/layout\/nav-item\.tsx['"]/,
            );
        });

        it('the exempt-list size limit is in place (current ceiling: 10)', () => {
            // 5 was the cap before R13. R13-PR8 bumped it to 6 to
            // admit nav-item.tsx. R14 broadened it to 11 to admit
            // the top-bar slot family (nav-bar.tsx + 4 slot files);
            // the searchbar-kill sweep retired SearchAnchor and the
            // cap dropped back to 10. Lock the CURRENT cap — the
            // motion-language ratchet itself owns this number, and
            // any future broadening must argue there.
            expect(MOTION_GUARD_SRC).toMatch(
                /EXEMPT_FILES\.size\)\.toBeLessThanOrEqual\(10\)/,
            );
        });

        it('the broadening rationale for nav-item is documented in the exempt comment', () => {
            // The comment block above the `src/components/layout/
            // nav-item.tsx` entry MUST explain WHY the file is
            // exempt. Future readers need this context — a bare
            // path with no reason invites cargo-cult exemptions
            // ("ah, looks like this is where you put files that
            // animate on hover").
            expect(MOTION_GUARD_SRC).toMatch(
                /Roadmap-13[\s\S]*?nav-item\.tsx/,
            );
            expect(MOTION_GUARD_SRC).toMatch(
                /press[\s-]?down|press feedback|active:translate/i,
            );
        });
    });
});
