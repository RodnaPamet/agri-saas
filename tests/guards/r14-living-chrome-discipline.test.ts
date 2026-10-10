/**
 * Roadmap-14 PR-10 — Living chrome visual parity with R13 sidebar.
 *
 * The R13 living-sidebar vocabulary (band gradient + glow, gloss
 * highlight, fading gradient dividers, radial brand wash) gets
 * transplanted to the top-bar. After PR-10 the two pieces of
 * chrome (sidebar + top-bar) read as one cohesive surface — same
 * tokens, same recipes, applied at the right scale for each.
 *
 * Three visual additions:
 *
 *   (1) **Right-edge radial brand wash** — `--brand-subtle`
 *       radial-gradient anchored at the right edge of the bar,
 *       fading to transparent at left. Mirrors R13-PR11's active-
 *       row treatment but at the global chrome level. The wash
 *       gives the bar a quiet brand presence on the side that
 *       owns identity (user menu, notifications, switcher).
 *
 *   (2) **Top-edge gloss highlight** — `::after` pseudo-element
 *       carrying `--nav-gloss-highlight` (theme-aware: white @ 8%
 *       METRO, white @ 70% PwC). Same recipe as `<NavItem>` from
 *       R13-PR6, scaled to the chrome. Inset 16px each side so it
 *       doesn't run to the corners.
 *
 *   (3) **Bottom-edge fading hairline** — `::before` pseudo-element
 *       painting a horizontal gradient from transparent → border-
 *       subtle → transparent. Replaces the R14-PR2 `border-b` with
 *       the same R13-PR10 evolution `<NavSection>` made for its
 *       dividers. The seam reads as breath, not architecture.
 *
 * Discipline:
 *
 *   - All three additions go through theme-aware CSS variables
 *     (`--brand-subtle`, `--nav-gloss-highlight`, `--border-subtle`).
 *     A regression that hardcodes rgba() values breaks theme parity.
 *
 *   - Pseudo-elements are pointer-events-none. Without this the
 *     overlays would capture clicks at the top + bottom edges of
 *     the bar.
 *
 *   - The shell composes `relative` to anchor the absolute pseudo
 *     positioning. Without it, the gloss + hairline escape to the
 *     next positioned ancestor.
 *
 *   - The R14-PR2 `border-b border-border-subtle` is RETIRED (the
 *     bottom-edge hairline replaces it). Both forms must not
 *     coexist — would render two seams.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
const NAV_BAR_SRC = fs.readFileSync(
    path.join(ROOT, 'src/components/layout/nav-bar.tsx'),
    'utf8',
);

describe('Roadmap-14 PR-10 — Living chrome visual parity', () => {
    describe('NAV_BAR_SURFACE — right-edge radial brand wash', () => {
        it('declares the radial-gradient via `[background-image:radial-gradient(...)]`', () => {
            // The `[background-image:...]` arbitrary-property form
            // is the only way to set background-image without also
            // wiping the bg-color (which carries the glass tint).
            expect(NAV_BAR_SRC).toMatch(
                /\[background-image:radial-gradient\(/,
            );
        });

        it('anchors the radial at the right edge (`circle at right`)', () => {
            // Right-anchored — the side that owns identity (user
            // menu, notifications, switcher). Left-anchored would
            // distract from the brand mark + breadcrumbs.
            expect(NAV_BAR_SRC).toMatch(
                /\[background-image:radial-gradient\(circle_at_right,/,
            );
        });

        it('peaks at `--brand-subtle` (theme-aware token)', () => {
            // `--brand-subtle` is alpha-tuned per theme (METRO
            // yellow @ 18%, PwC orange @ 9%). A hardcoded rgba
            // would break theme parity.
            expect(NAV_BAR_SRC).toMatch(
                /\[background-image:radial-gradient\([^\]]+var\(--brand-subtle\)/,
            );
        });

        it('fades to transparent at 60% so the centre stays clear', () => {
            // The wash MUST fade before reaching the centre slot
            // (where the search anchor lives) — otherwise the
            // brand tint would compete with the search pill's
            // own background. 60% is the sweet spot.
            expect(NAV_BAR_SRC).toMatch(
                /\[background-image:radial-gradient\([^\]]+,_transparent_60%\)/,
            );
        });

        it('keeps the glass-blur bg-color (no regression to opaque)', () => {
            // The radial OVERLAYS the glass; both must coexist.
            // A regression that drops `bg-bg-page/80 backdrop-blur-sm`
            // would lose the frosted-glass effect.
            const surfaceRegion =
                NAV_BAR_SRC.match(
                    /export\s+const\s+NAV_BAR_SURFACE\s*=\s*['"]([^'"]+)['"]/,
                )?.[1] ?? '';
            expect(surfaceRegion).toMatch(/bg-bg-page\/80/);
            expect(surfaceRegion).toMatch(/backdrop-blur-sm/);
        });
    });

    describe('NAV_BAR_BOTTOM_HAIRLINE — fading gradient seam (replaces R14-PR2 border-b)', () => {
        const recipeRegion =
            NAV_BAR_SRC.match(
                /export\s+const\s+NAV_BAR_BOTTOM_HAIRLINE\s*=\s*['"]([^'"]+)['"]/,
            )?.[1] ?? '';

        it('uses `::before` pseudo pinned to the bottom edge', () => {
            expect(recipeRegion).not.toBe('');
            expect(recipeRegion).toMatch(/before:absolute/);
            expect(recipeRegion).toMatch(/before:bottom-0/);
            expect(recipeRegion).toMatch(/before:left-0/);
            expect(recipeRegion).toMatch(/before:right-0/);
            expect(recipeRegion).toMatch(/before:h-px/);
        });

        it('paints a linear-gradient(90deg, transparent → --border-subtle → transparent)', () => {
            expect(recipeRegion).toMatch(
                /before:bg-\[linear-gradient\(90deg,/,
            );
            expect(recipeRegion).toMatch(/var\(--border-subtle\)/);
            // Both transparent stops — fade in AND out, not one-sided.
            const transparents =
                recipeRegion.match(/transparent/g)?.length ?? 0;
            expect(transparents).toBeGreaterThanOrEqual(2);
        });

        it('is `pointer-events-none` (decoration only)', () => {
            // Without this the overlay captures clicks at the
            // bar's bottom-1px edge.
            expect(recipeRegion).toMatch(/before:pointer-events-none/);
        });
    });

    describe('NAV_BAR_TOP_GLOSS — top-edge highlight', () => {
        const recipeRegion =
            NAV_BAR_SRC.match(
                /export\s+const\s+NAV_BAR_TOP_GLOSS\s*=\s*['"]([^'"]+)['"]/,
            )?.[1] ?? '';

        it('uses `::after` pseudo pinned to the top edge', () => {
            expect(recipeRegion).not.toBe('');
            expect(recipeRegion).toMatch(/after:absolute/);
            expect(recipeRegion).toMatch(/after:top-0/);
            expect(recipeRegion).toMatch(/after:h-px/);
        });

        it('insets 16px from each side (so it does NOT run to the corners)', () => {
            // Inset = deliberate highlight, not hairline divider.
            // Same R13-PR6 logic scaled to the chrome.
            expect(recipeRegion).toMatch(/after:left-4/);
            expect(recipeRegion).toMatch(/after:right-4/);
        });

        it('paints from `--nav-gloss-highlight` (theme-aware)', () => {
            // R13-PR6 introduced this token. Reusing it here gives
            // the topbar and the sidebar rows the same gloss tone.
            expect(recipeRegion).toMatch(
                /after:bg-\[var\(--nav-gloss-highlight\)\]/,
            );
        });

        it('rounds the line ends so the highlight tapers softly', () => {
            // Same R13-PR6 vocabulary — `rounded-full` on a 1px-
            // tall element rounds the horizontal ends.
            expect(recipeRegion).toMatch(/after:rounded-full/);
        });

        it('is `pointer-events-none`', () => {
            expect(recipeRegion).toMatch(/after:pointer-events-none/);
        });
    });

    describe('NAV_BAR_SHELL composes the three layers', () => {
        const shellRegion =
            NAV_BAR_SRC.match(
                /export\s+const\s+NAV_BAR_SHELL\s*=\s*\[[\s\S]+?\]\.join\(/,
            )?.[0] ?? '';

        it('includes `relative` (anchors the absolute pseudos)', () => {
            // Without `relative` the pseudos escape to the next
            // positioned ancestor (probably `<main>` or `<body>`).
            expect(shellRegion).toMatch(/['"]relative\s+items-center/);
        });

        it('references NAV_BAR_BOTTOM_HAIRLINE', () => {
            expect(shellRegion).toContain('NAV_BAR_BOTTOM_HAIRLINE');
        });

        it('references NAV_BAR_TOP_GLOSS', () => {
            expect(shellRegion).toContain('NAV_BAR_TOP_GLOSS');
        });
    });

    describe('retired vocabulary — no parallel border + hairline', () => {
        it('NAV_BAR_SURFACE does NOT carry the R14-PR2 `border-b`', () => {
            // Strip comments first — the doc-comment legitimately
            // references the retired form by name.
            const stripped = blankNonCode(NAV_BAR_SRC);
            const surfaceMatch = stripped.match(
                /export\s+const\s+NAV_BAR_SURFACE\s*=\s*['"]([^'"]+)['"]/,
            );
            expect(surfaceMatch).not.toBeNull();
            const recipe = surfaceMatch![1];
            expect(recipe).not.toMatch(/\bborder-b\b/);
            expect(recipe).not.toMatch(/\bborder-border-subtle\b/);
        });
    });
});
