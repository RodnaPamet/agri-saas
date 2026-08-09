'use client';

/**
 * Roadmap-14 PR-1 — `<NavBar>` primitive.
 *
 * The top-bar's only first-class structural element. Every later
 * R14 PR (geometry lock, brand mark, env badge, switcher, search,
 * notifications, user menu, living-chrome polish, mobile parity)
 * edits this file and the slot-children it accepts — never adds
 * a parallel `<header>` elsewhere.
 *
 * Why a separate file:
 *
 *   - Previously `<TopChrome>` (in `TopChrome.tsx`) hand-rolled the
 *     entire `<header>` element + its child layout. It worked, but
 *     it locked the shell shape inside the file that ALSO composes
 *     the breadcrumbs + identity pill. Mixing "what the bar looks
 *     like" with "what the bar shows today" makes every later PR
 *     touch a complex file.
 *
 *   - Hoisting the recipe into one primitive (and exporting the
 *     class strings as named consts) gives R14 a single place to
 *     land every slot. The ratchet
 *     `tests/guards/nav-bar-import-discipline.test.ts` locks the
 *     contract: no parallel `<header role="banner">` with the
 *     load-bearing chrome geometry outside this file.
 *
 * Slot architecture (locked by PR-1, filled by PR-3 onwards):
 *
 *   left      brand mark · env badge · breadcrumbs
 *             (PR-3 adds brand · PR-9 adds env badge ·
 *              breadcrumbs already there in PR-1)
 *
 *   center    global search anchor (⌘K)
 *             (PR-6 adds the search pill)
 *
 *   right     notifications · context · account
 *             (PR-4 swaps identity pill → workspace switcher ·
 *              PR-5 adds user menu · PR-7 adds notifications)
 *
 * Each slot is a discrete React node consumed by the structural
 * shell. The shell is responsible for SPACING and ALIGNMENT only;
 * the slots own their own content + state.
 *
 * Why slot props (not compound components like `<NavBar.Brand/>`)?
 *
 *   - Type-safety: a `left?: ReactNode` prop is just JSX-validated.
 *     A compound-component pattern (`NavBar.Brand = ...`) requires
 *     React.Children sniffing or context plumbing to enforce slot
 *     placement, which adds runtime overhead for zero ergonomic
 *     benefit at this scale.
 *
 *   - Matches the codebase: `<EntityListPage>` and
 *     `<EntityDetailLayout>` (Epic 52 / R13 era) both use slot
 *     props, not compound components. Consistency over fashion.
 *
 *   - SSR-safe: slot props serialize cleanly across the RSC
 *     boundary. Compound components with `displayName` checks can
 *     hit edge cases in production builds.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { AgrentMark } from './AgrentLogo';
import { Menu } from 'lucide-react';

// ─── Geometry tokens (R14-PR2) ─────────────────────────────────────
//
// Five measurements drive how the top-bar feels on the page. Each
// is a named const so the rationale lives next to the value. A
// future "just bump height by 4px" PR has to argue against both
// the doc-comment and the ratchet at
// `tests/guards/r14-nav-bar-geometry-discipline.test.ts`.

/**
 * **64px desktop height.** R14-PR2 bumped this from R2-era 56px
 * (`h-14`). Reasoning: the bar will host a brand mark (32px), a
 * search anchor (28px), a user-avatar button (32px), and a
 * notifications bell (28px) — fitting all four at 56px feels
 * cramped, and the brand mark loses presence next to the
 * breadcrumbs. 64px gives each practice an 8px halo of breathing
 * room above + below.
 *
 * `h-16` resolves to 64px in Tailwind's default spacing scale
 * (4px × 16). Pairs cleanly with `NAV_BAR_GAP` (8px) — the
 * horizontal rhythm and the vertical rhythm share a multiple.
 */
export const NAV_BAR_HEIGHT = 'h-16';

/**
 * **16px horizontal padding mobile, 24px desktop.** The bar lives
 * flush with the viewport edges; the left + right padding is the
 * only breath between the first slot's content and the screen
 * edge. 16px is the minimum that doesn't look amateur; 24px on
 * desktop matches the page-content `md:p-6` so the bar's edges
 * align with the content below it (the eye reads "everything is
 * on the same grid").
 *
 * `px-4 md:px-6` resolves to 16px / 24px — Tailwind's spacing
 * scale at 4-unit + 6-unit.
 */
export const NAV_BAR_PADDING = 'px-4 md:px-6';

/**
 * **8px gap between slots.** The shell uses `justify-between` so
 * the three slots (left, centre, right) anchor to their edges;
 * the `gap-default` is the fallback breath if any two slots end
 * up adjacent.
 *
 * `gap-default` resolves to 8px via the semantic spacing scale
 * (Roadmap-5 PR-9). Same vocabulary the sidebar + every premium
 * primitive uses. Mixing 6/8/12px gaps across primary chrome
 * reads as un-decided.
 */
export const NAV_BAR_GAP = 'gap-default';

/**
 * **Sticky-positioned at the top, z-30.** The bar must stay
 * pinned as the user scrolls page content; `top-0` anchors it,
 * `sticky` keeps the element in flow so the chrome doesn't
 * overlap the first row of content the way `fixed` would.
 *
 * z-30 sits ABOVE row-sticky headers (which use z-20 for pinned
 * table column headers) but BELOW modal overlays (z-50). Modals
 * SHOULD obscure the chrome.
 */
export const NAV_BAR_POSITION = 'sticky top-0 z-30';

/**
 * **Living-chrome surface — glass + radial brand wash.** R14-PR10
 * evolves the R14-PR2 base.
 *
 * Three layered pieces (the bar reads as one cohesive surface):
 *
 *   (1) `bg-bg-page/80` — the frosted-glass tint over the page bg.
 *       `/80` alpha + `backdrop-blur-sm` is the recipe the macOS /
 *       Notion / Linear nav chromes all converge on; doesn't choke
 *       on scrolling content underneath.
 *
 *   (2) `[background-image:radial-gradient(circle at right,
 *       --brand-subtle, transparent 60%)]` — a brand-tinted radial
 *       wash anchored at the right edge (where the user menu
 *       lives). Mirrors R13-PR11's active-row treatment but at the
 *       global chrome level. The right-anchored wash gives the bar
 *       a quiet brand presence without overwhelming the centre
 *       (where the search anchor lives) or the breadcrumbs (left
 *       slot).
 *
 *   (3) The bottom-edge fading-gradient hairline + top-edge gloss
 *       are NOT in this recipe — they live in NAV_BAR_SHELL via
 *       `::before` / `::after` pseudo-elements (R13-PR10 +
 *       R13-PR6 parity, transplanted to the chrome).
 *
 * `border-b border-border-subtle` (R14-PR2 inline form) is RETIRED
 * — the structural ratchet at
 * `tests/guards/r14-nav-bar-geometry-discipline.test.ts` accepts
 * either form (the R14-PR10 evolution is documented inline).
 */
export const NAV_BAR_SURFACE =
    'bg-bg-page/80 backdrop-blur-sm [background-image:radial-gradient(circle_at_right,_var(--brand-subtle),_transparent_60%)]';

/**
 * **Bottom-edge fading hairline (R13-PR10 parity).**
 *
 * Replaces the R14-PR2-era `border-b border-border-subtle` with a
 * `::before` pseudo-element painting a horizontal gradient that
 * fades from transparent at each edge to `--border-subtle` at
 * centre and back to transparent. The seam reads as breath, not
 * architecture — same evolution `<NavSection>` made in R13-PR10.
 */
export const NAV_BAR_BOTTOM_HAIRLINE =
    'before:absolute before:bottom-0 before:left-0 before:right-0 before:h-px before:bg-[linear-gradient(90deg,_transparent,_var(--border-subtle),_transparent)] before:pointer-events-none';

/**
 * **Slot press-feedback recipe (R14-PR11).**
 *
 * The single tactile micro-motion every clickable top-bar slot
 * shares. On mousedown the slot drops 1px (`active:translate-y-px`),
 * the universal "I just pressed something physical" cue. Pairs
 * with the slot's own hover treatment (brightness / bg-tone shift).
 *
 * Three tokens, each load-bearing:
 *
 *   `transition-transform duration-75 ease-out`
 *       Fast snappy press tempo. 75ms is the snappy zone — fast
 *       enough to feel immediate, long enough to read as motion
 *       rather than teleport. Matches the NavItem press recipe
 *       (R13-PR8) so the chrome + sidebar feel identical to the
 *       hand.
 *
 *   `active:translate-y-px`
 *       1px mousedown drop. CSS `:active` only — hover-translate /
 *       hover-scale stay banned by the local R14 ratchets and the
 *       global motion-language ratchet.
 *
 *   `motion-reduce:active:translate-y-0`
 *       OS-preference safety net. Reduced-motion users see zero
 *       displacement. The tokens.css global only flattens
 *       animation-duration (not static transforms); the explicit
 *       override here is required.
 *
 * R14-PR11 wires this recipe into every clickable chrome slot —
 * brand mark, search anchor (both forms), tenant switcher trigger,
 * notifications bell, user-menu avatar. The shared recipe means a
 * future "let's slow the press to 100ms" PR has ONE place to
 * land — every slot's tactile feel stays coherent.
 *
 * Motion-language exempt: nav-bar.tsx, tenant-switcher.tsx,
 * user-menu.tsx, notifications-bell.tsx, search-anchor.tsx are
 * all added to the EXEMPT_FILES list in
 * `motion-language-discipline.test.ts`. The broadening rationale
 * mirrors R13-PR8's nav-item.tsx exempt: chrome is the canonical
 * place for tactile micro-motion; the bans on hover-translate /
 * hover-scale / hover-shadow still apply within these files via
 * the local R14 ratchets.
 */
export const NAV_BAR_SLOT_PRESS =
    'transition-transform duration-75 ease-out active:translate-y-px motion-reduce:active:translate-y-0';

/**
 * **Top-edge gloss highlight (R13-PR6 parity).**
 *
 * A 1px highlight at the top edge of the chrome, inset 16px each
 * side so it doesn't run all the way to the corners — same recipe
 * as `<NavItem>`'s gloss treatment from R13-PR6, scaled up to the
 * chrome's geometry. Theme-aware via `--nav-gloss-highlight`
 * (white @ 8% METRO, white @ 70% PwC).
 */
export const NAV_BAR_TOP_GLOSS =
    'after:absolute after:top-0 after:left-4 after:right-4 after:h-px after:bg-[var(--nav-gloss-highlight)] after:rounded-full after:pointer-events-none';

/**
 * Shell recipe — composes the five geometry tokens above into the
 * `<header>`'s class string. PR-1 declared this inline; PR-2
 * extracts each piece into a named token. The `hidden md:flex` +
 * `items-center justify-between` are layout-mode declarations
 * (not geometry) and stay here.
 *
 * `hidden md:flex` is the dual-chrome compromise of today — the
 * desktop bar hides below md while AppShell renders a mobile-only
 * bar. R14-PR12 unifies the two; until then the mobile bar is
 * the authoritative mobile surface.
 */
/**
 * R14-PR12 retired the `hidden md:flex` gate — the shell now
 * renders on all viewports. The mobile-only top bar inside
 * `<AppShell>` was deleted in the same diff; this NavBar is the
 * single chrome surface across mobile + desktop.
 *
 * Responsive slot behaviour is handled inside each slot's own
 * recipe (search → icon-only below lg, breadcrumbs → hidden
 * below md, tenant switcher → hidden below sm).
 */
export const NAV_BAR_SHELL = [
    'flex',
    NAV_BAR_POSITION,
    NAV_BAR_HEIGHT,
    // mobile-native-feel PR-4b — top-notch clearance for the installed
    // PWA. `viewport-fit=cover` lets the status-bar / camera notch overlap
    // the top of the viewport; `.safe-area-top` adds `env(safe-area-inset-top)`
    // as PADDING and the `min-h-[calc(...)]` grows the bar by the same inset,
    // so the 64px (`h-16`) content band still clears the notch instead of
    // hiding under it. On non-notched devices the inset resolves to 0, so
    // `min-height` == `h-16` and nothing changes (desktop untouched, env=0).
    'safe-area-top',
    'min-h-[calc(4rem+env(safe-area-inset-top))]',
    // `relative` anchors the `::before` (bottom hairline) and
    // `::after` (top gloss) pseudo-elements. Without it the
    // pseudo's absolute positioning escapes to the next
    // positioned ancestor.
    'relative items-center justify-between',
    NAV_BAR_GAP,
    NAV_BAR_SURFACE,
    NAV_BAR_BOTTOM_HAIRLINE,
    NAV_BAR_TOP_GLOSS,
    NAV_BAR_PADDING,
].join(' ');

/**
 * Left-slot recipe — flex row that hugs left, truncates gracefully.
 *
 * `min-w-0` is load-bearing: without it the breadcrumbs slot would
 * push the centre + right slots off the right edge instead of
 * truncating itself.
 */
export const NAV_BAR_SLOT_LEFT =
    'flex min-w-0 flex-1 items-center gap-default';

/**
 * Centre-slot recipe — fixed width, never grows past the search
 * pill's natural size.
 *
 * PR-1 leaves this empty (the centre slot is unused today). PR-6
 * fills it with the ⌘K search anchor. The slot's geometry stays
 * stable across centre-filled / centre-empty states so the layout
 * doesn't shift when search lands.
 */
export const NAV_BAR_SLOT_CENTER =
    'flex shrink-0 items-center justify-center';

/**
 * Right-slot recipe — flex row that hugs right.
 *
 * The mirror of the left slot. Together with the centre slot they
 * form a 3-region grid that the eye reads as "anchor — verb —
 * identity".
 */
export const NAV_BAR_SLOT_RIGHT =
    'flex shrink-0 items-center justify-end gap-default';

// ─── Brand mark (R14-PR3) ──────────────────────────────────────────

/**
 * **The brand mark recipe.**
 *
 * 22×22 rounded square containing the product's two-letter initials
 * over a 3-stop brand gradient. The visual signature of the chrome.
 *
 * Six load-bearing tokens, each documented:
 *
 *   (1) `h-[22px] w-[22px]` — 22×22 footprint. The compact navbar
 *       practice size (stepped 32 → 28 → 22), matched across brand /
 *       bell / user-menu / mobile-menu / tenant-switcher so the
 *       practices read as one tight set within the 64px bar.
 *
 *   (2) `rounded-lg` — 8px corner radius. Parity with `<NavItem>`
 *       and the `<Button>` primitive (both rounded-lg). Mixing
 *       corner radii across primary chrome reads as un-decided.
 *
 *   (3) **3-stop brand gradient at 200% bg-size.** Same hue family
 *       as the R13-PR2 band: `from-default → via-muted → to-emphasis`.
 *       The 200% horizontal size gives the `nav-brand-pulse`
 *       animation room to pan the gradient left → right → left.
 *       The mark visibly "breathes" without geometry change.
 *
 *   (4) `shadow-[var(--nav-band-glow)]` — same outer glow token as
 *       the band (R13-PR2). Coordinates the chrome's two brand
 *       surfaces (brand mark + band on active row) as one piece
 *       of jewellery.
 *
 *   (5) `text-content-inverted text-[11px] font-bold` — the
 *       initials text. Inverted-content (dark on yellow METRO,
 *       white on dark PwC). 11px is the smallest size at which
 *       bold "AG" reads clearly at 32×32 without looking cramped.
 *
 *   (6) `animate-nav-brand-pulse` — the 6s breath. Tempo
 *       deliberately slower than the band's 4s so the eye reads
 *       a hierarchy.
 *
 * Hover treatment: `hover:brightness-110` warms the mark on
 * pointer-over. Filter is not in the motion-language ban list
 * (which targets transform / scale / outer-shadow / translate);
 * brightness is the right tool for "this is clickable, the light
 * just came on".
 *
 * Accessibility:
 *   • `<Link>` with `aria-label` carrying the full product name
 *     + destination ("Agrent — go to dashboard").
 *   • Visible "AG" initials are `aria-hidden="true"` — they're a
 *     visual signature, not the accessible name.
 *   • `focus-visible:ring-2` for keyboard story (same vocabulary
 *     as `<NavItem>` + `<Button>`).
 *
 * H1-rule carve-out: the R7 `single-h1-per-page` ratchet bans
 * multiple H1s. The brand mark is NOT a heading element — it's a
 * `<Link>` with `aria-label`. The R14-PR3 recipe deliberately
 * avoids `<h1>` to preserve the page-content H1 as the canonical
 * page heading. Documented inline so a future "let's make this an
 * h1 for SEO" PR has to argue against it.
 */
export const NAV_BAR_BRAND_CLASS = [
    // Geometry — 28px navbar practice footprint (one step below the
    // legacy 32px; matches the bell / user-menu / mobile-menu practices).
    'relative h-[22px] w-[22px] rounded-lg flex-shrink-0',
    // Flex / type
    'flex items-center justify-center',
    'text-content-inverted text-[11px] font-bold',
    // Brand gradient (3-stop) + bg-size for the pan animation
    'bg-gradient-to-r from-[var(--brand-default)] via-[var(--brand-muted)] to-[var(--brand-emphasis)]',
    'bg-[length:200%_100%]',
    // Outer glow — same token as the band
    'shadow-[var(--nav-band-glow)]',
    // Slow 6s pulse via background-position pan
    'animate-nav-brand-pulse',
    // Hover — brightness, NOT shadow/transform/scale (motion-language safe)
    'transition-[filter] duration-200 ease-out hover:brightness-110',
    // Press feedback (R14-PR11 shared slot recipe).
    NAV_BAR_SLOT_PRESS,
    // Focus story — match NavItem / Button vocabulary
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-bg-page',
].join(' ');

export interface NavBarBrandProps {
    /** Destination href — usually the dashboard root for the current variant. */
    href: string;
    /** Accessible name. */
    ariaLabel?: string;
}

export function NavBarBrand({
    href,
    ariaLabel = 'Agrent — go to dashboard',
}: NavBarBrandProps) {
    return (
        <Link
            href={href}
            aria-label={ariaLabel}
            className={NAV_BAR_BRAND_CLASS}
            data-testid="nav-bar-brand"
        >
            {/* The seedling mark inherits the box's `text-content-inverted`
                (navy) via currentColor; it's decorative — the accessible name
                is the Link's aria-label. */}
            <AgrentMark className="h-[15px] w-[15px]" />
        </Link>
    );
}

// ─── Mobile menu button (R14-PR12) ────────────────────────────────

/**
 * Hamburger button that opens the sidebar drawer on mobile. Hidden
 * at `md+` where the desktop sidebar is always-visible.
 *
 * R14-PR12 unified the chrome — the pre-R14 `<AppShell>` rendered
 * a SEPARATE mobile-only top bar carrying its own hamburger; this
 * button is the canonical mobile hamburger now. AppShell owns the
 * drawer state and passes `onClick` through `<TopChrome>` to this
 * component.
 */
export interface NavBarMobileMenuProps {
    onClick: () => void;
    /** A11y label override — defaults to "Open navigation menu". */
    ariaLabel?: string;
    /** Test id — defaults to "nav-toggle"; org variant overrides. */
    dataTestId?: string;
}

export function NavBarMobileMenu({
    onClick,
    ariaLabel = 'Open navigation menu',
    dataTestId = 'nav-toggle',
}: NavBarMobileMenuProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`md:hidden inline-flex items-center justify-center h-[22px] w-[22px] rounded-lg text-content-muted transition-colors hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${NAV_BAR_SLOT_PRESS}`}
            aria-label={ariaLabel}
            data-testid={dataTestId}
        >
            <Menu className="h-4 w-4" aria-hidden="true" />
        </button>
    );
}

// ─── Component ───

export interface NavBarProps {
    /**
     * Left slot — brand · env badge · breadcrumbs.
     * Truncates gracefully when wide content (long breadcrumb
     * trails) collides with the centre slot.
     */
    left?: ReactNode;
    /**
     * Centre slot — global search anchor (filled by R14-PR6).
     * Stays empty in PR-1; the slot exists for layout stability.
     */
    center?: ReactNode;
    /**
     * Right slot — notifications · context · account.
     * Anchored to the right edge; never grows.
     */
    right?: ReactNode;
}

/**
 * The structural shell for the top-bar. Three named slots; the
 * shell owns spacing + alignment, slots own their content + state.
 *
 * Mounted once by `<TopChrome>`. Future R14 PRs add slot content;
 * the shell's geometry stays locked.
 */
export function NavBar({ left, center, right }: NavBarProps) {
    return (
        <header
            className={NAV_BAR_SHELL}
            role="banner"
            data-testid="nav-bar"
        >
            <div className={NAV_BAR_SLOT_LEFT} data-slot="left">
                {left}
            </div>
            <div className={NAV_BAR_SLOT_CENTER} data-slot="center">
                {center}
            </div>
            <div className={NAV_BAR_SLOT_RIGHT} data-slot="right">
                {right}
            </div>
        </header>
    );
}
