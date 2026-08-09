/**
 * Roadmap-14 PR-3 — animated brand wordmark discipline.
 *
 * The brand mark is the visual signature of the chrome — a 32×32
 * rounded square with a 3-stop brand gradient, an outer glow, a
 * 6-second slow pulse via background-position pan, and a
 * brightness-on-hover treatment. Mounts in the left slot of every
 * authenticated `<TopChrome>` instance, before breadcrumbs.
 *
 * The recipe coordinates the chrome's two brand surfaces:
 *
 *   • Sidebar band (R13-PR2) — 3-stop gradient, glow, 4s shimmer
 *   • Top-bar brand (R14-PR3) — 3-stop gradient, glow, 6s pulse
 *
 * Same gradient stops, same glow token, different tempos (band
 * leads at 4s, brand follows at 6s — visual hierarchy). The eye
 * reads them as one piece of jewellery across two locations.
 *
 * Eight load-bearing invariants:
 *
 *   1. `NAV_BAR_BRAND_CLASS` exported + composed via `.join(' ')`
 *      so each token is greppable.
 *   2. 32×32 footprint (`w-8 h-8`).
 *   3. 8px corner radius (`rounded-lg`).
 *   4. 3-stop brand gradient — `from-default → via-muted →
 *      to-emphasis`, same hue family as the band.
 *   5. `bg-[length:200%_100%]` — gives the pan animation room.
 *   6. `--nav-band-glow` token reused (not a hardcoded shadow).
 *   7. `animate-nav-brand-pulse` — wired to the new tailwind
 *      keyframe at 6s ease-in-out infinite.
 *   8. Hover uses `brightness-110` (motion-language safe) — NOT
 *      transform / scale / shadow.
 *
 * Plus the H1-rule carve-out: the brand mark must NEVER be an
 * `<h1>` element. R7's single-h1-per-page ratchet bans multiple
 * H1s; the page-content H1 is the canonical heading.
 *
 * Plus the consumer wiring: `<TopChrome>` mounts `<NavBarBrand>`
 * with a variant-derived href, before breadcrumbs in the left slot.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const NAV_BAR_SRC = fs.readFileSync(
    path.join(ROOT, 'src/components/layout/nav-bar.tsx'),
    'utf8',
);
const TOP_CHROME_SRC = fs.readFileSync(
    path.join(ROOT, 'src/components/layout/TopChrome.tsx'),
    'utf8',
);
const TAILWIND_CONFIG = fs.readFileSync(
    path.join(ROOT, 'tailwind.config.js'),
    'utf8',
);

describe('Roadmap-14 PR-3 — NavBar brand mark discipline', () => {
    describe('recipe — NAV_BAR_BRAND_CLASS', () => {
        const brandRegion =
            NAV_BAR_SRC.match(
                /export\s+const\s+NAV_BAR_BRAND_CLASS\s*=\s*\[[\s\S]+?\]\.join\(/,
            )?.[0] ?? '';

        it('exports NAV_BAR_BRAND_CLASS as an array `.join(\' \')` composition', () => {
            // Array form makes each token greppable. A regression
            // to a single string literal couples the values to the
            // const and the ratchet's per-token asserts lose their
            // anchor.
            expect(brandRegion).not.toBe('');
            expect(brandRegion).toMatch(/\[\s*$|\[\s*\n/);
        });

        it('footprint is 22×22 (`h-[22px] w-[22px]`)', () => {
            // 22px navbar practice footprint — stepped 32 → 28 → 22,
            // matched across brand / bell / user-menu / mobile-menu /
            // tenant-switcher so the practices read as one tight set
            // within the 64px bar.
            expect(brandRegion).toContain('w-[22px]');
            expect(brandRegion).toContain('h-[22px]');
        });

        it('corner radius is `rounded-lg`', () => {
            // Parity with NavItem + Button primitives.
            expect(brandRegion).toContain('rounded-lg');
        });

        it('paints the 3-stop brand gradient (same hue family as the band)', () => {
            // `from-default → via-muted → to-emphasis` — same R13
            // recipe. Direction `bg-gradient-to-r` (horizontal) so
            // the pan animation reads as left-to-right "breath".
            expect(brandRegion).toMatch(/bg-gradient-to-r/);
            expect(brandRegion).toMatch(
                /from-\[var\(--brand-default\)\]/,
            );
            expect(brandRegion).toMatch(/via-\[var\(--brand-muted\)\]/);
            expect(brandRegion).toMatch(
                /to-\[var\(--brand-emphasis\)\]/,
            );
        });

        it('sets background-size to 200% 100% (gives the pan room)', () => {
            // Without this the gradient covers the mark exactly and
            // the keyframe's position pan is a no-op.
            expect(brandRegion).toMatch(/bg-\[length:200%_100%\]/);
        });

        it('uses `--nav-band-glow` for the outer glow (not a hardcoded shadow)', () => {
            // Same theme-aware glow token as the sidebar band. A
            // regression to a hardcoded rgba would break theme
            // parity (yellow glow on PwC light theme).
            expect(brandRegion).toMatch(
                /shadow-\[var\(--nav-band-glow\)\]/,
            );
        });

        it('wires `animate-nav-brand-pulse` (the 6s breath)', () => {
            expect(brandRegion).toMatch(/animate-nav-brand-pulse/);
        });

        it('hover uses `brightness-110` (motion-language safe — not transform/scale/shadow)', () => {
            // Filter is not in the motion-language ban list.
            // Brightness is the right tool for "this is clickable;
            // the light just came on" without violating the
            // opacity-+-colour motion rule.
            expect(brandRegion).toMatch(/hover:brightness-110/);
            expect(brandRegion).not.toMatch(/hover:scale-/);
            expect(brandRegion).not.toMatch(/hover:translate-/);
            // Mark uses `shadow-[var(--nav-band-glow)]` un-prefixed
            // (static). A regression that adds `hover:shadow-`
            // would also trip the motion-language ratchet.
            expect(brandRegion).not.toMatch(/hover:shadow-/);
        });

        it('focus-visible carries the canonical ring vocabulary', () => {
            expect(brandRegion).toMatch(
                /focus-visible:ring-2/,
            );
            expect(brandRegion).toMatch(
                /focus-visible:ring-\[var\(--ring\)\]/,
            );
        });
    });

    describe('animation declaration in tailwind config', () => {
        it('declares `nav-brand-pulse` keyframe with the bg-position palindrome', () => {
            expect(TAILWIND_CONFIG).toMatch(/'nav-brand-pulse':\s*\{/);
            // Palindrome shape (0%, 100% identical position; 50%
            // opposite) — back-and-forth pan, seamless loop.
            const blockMatch = TAILWIND_CONFIG.match(
                /'nav-brand-pulse':\s*\{[\s\S]*?'0%,\s*100%':\s*\{\s*'background-position':\s*'0%\s+50%'\s*\}/,
            );
            expect(blockMatch).not.toBeNull();
            const midMatch = TAILWIND_CONFIG.match(
                /'nav-brand-pulse':\s*\{[\s\S]*?'50%':\s*\{\s*'background-position':\s*'100%\s+50%'\s*\}/,
            );
            expect(midMatch).not.toBeNull();
        });

        it('wires `animation.nav-brand-pulse` at 6s ease-in-out infinite', () => {
            // 6s deliberately slower than the band's 4s — visual
            // hierarchy + cognitive load (different tempos let the
            // eye treat each as separate choreography).
            expect(TAILWIND_CONFIG).toMatch(
                /'nav-brand-pulse':\s*'nav-brand-pulse\s+6s\s+ease-in-out\s+infinite'/,
            );
        });
    });

    describe('accessibility', () => {
        it('NavBarBrand exports + renders a <Link> with aria-label', () => {
            expect(NAV_BAR_SRC).toMatch(
                /export\s+function\s+NavBarBrand\b/,
            );
            // The component MUST use <Link> (next/navigation) so
            // SPA navigation works, AND carry an aria-label as the
            // accessible name. The visible "IC" initials are
            // aria-hidden.
            expect(NAV_BAR_SRC).toMatch(/<Link\b/);
            expect(NAV_BAR_SRC).toMatch(/aria-label=\{ariaLabel\}/);
        });

        it('renders the decorative Agrent mark, not text initials', () => {
            // #16: the placeholder "AG" initials were replaced by the
            // Agrent seedling logo. The mark is a SIGNATURE, not the
            // accessible name — screen readers announce the Link's
            // aria-label ("Agrent — go to dashboard"). `<AgrentMark>` is
            // aria-hidden by default, so it adds no a11y noise. This
            // assertion replaces the former `{initials}` span lock.
            expect(NAV_BAR_SRC).toMatch(/from ['"]\.\/AgrentLogo['"]/);
            expect(NAV_BAR_SRC).toMatch(/<AgrentMark\b/);
            // The old initials span must be gone — no text mark left behind.
            expect(NAV_BAR_SRC).not.toMatch(/>\{initials\}</);
        });
    });

    describe('H1-rule carve-out (R7 single-h1-per-page)', () => {
        it('the brand mark recipe never renders an <h1> element', () => {
            // R7's `single-h1-per-page` ratchet bans multiple H1s.
            // The brand mark is a <Link> with aria-label — NOT an
            // <h1>. A regression that "promotes" the mark to <h1>
            // (for "SEO") would silently break every page where
            // page content carries its own H1.
            //
            // Strip comments before scanning so the doc-comment's
            // explanatory mention of `<h1>` doesn't trip the
            // structural detector.
            const stripped = NAV_BAR_SRC
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/[^\n]*/g, '');
            expect(stripped).not.toMatch(/<h1\b/);
        });
    });

    describe('consumer wiring (TopChrome)', () => {
        it('TopChrome imports NavBarBrand alongside NavBar', () => {
            expect(TOP_CHROME_SRC).toMatch(
                /import\s+\{[^}]*\bNavBar\b[^}]*\bNavBarBrand\b[^}]*\}\s+from\s+['"]\.\/nav-bar['"]/,
            );
        });

        it('TopChrome mounts <NavBarBrand> with a variant-derived href', () => {
            // The brand mark renders inside the left slot, BEFORE
            // breadcrumbs. A regression that drops the mark or
            // puts it elsewhere breaks the chrome's visual identity.
            expect(TOP_CHROME_SRC).toMatch(/<NavBarBrand\s+href=\{/);
            // The variant ternary computes the href — tenant goes
            // to `/t/<slug>/dashboard`, org goes to `/org/<slug>`.
            expect(TOP_CHROME_SRC).toMatch(/\/t\/\$\{params\.tenantSlug\}\/dashboard/);
            expect(TOP_CHROME_SRC).toMatch(/\/org\/\$\{params\.orgSlug\}/);
        });
    });
});
