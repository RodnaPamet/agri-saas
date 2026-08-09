'use client';

/**
 * Roadmap-12 PR-1 — `<NavItem>` primitive.
 *
 * The sidebar's only first-class element. Every later Roadmap-12 PR
 * (geometry lock, hover lick, active conviction, focus story, badge,
 * icon discipline) edits the tokens in this file and nowhere else.
 *
 * Why a separate file:
 *
 *   - Previously `NavItem` lived inline at the bottom of
 *     `SidebarNav.tsx`. The tenant sidebar mounts it; the org sidebar
 *     re-implements an almost-identical `OrgNavItem` in
 *     `OrgSidebarNav.tsx`. Two copies of the same recipe.
 *   - Hoisting the recipe into one primitive (and exporting the class
 *     strings as named consts) gives the rest of Roadmap-12 a single
 *     place to land changes. The ratchet
 *     `tests/guards/nav-item-import-discipline.test.ts` locks the
 *     contract: no hand-rolled `<Link>` with the load-bearing
 *     geometry (`min-h-[44px] rounded-lg`) outside this file.
 *
 * State vocabulary (locked by later PRs):
 *
 *   - default       muted text, transparent bg
 *   - hover         emphasis text, bg-muted/50 (R12-PR4 tightens)
 *   - active        emphasis text, brand-subtle bg, brand left-edge
 *   - focus-visible 2px ring at --ring (canonical yellow)
 *
 * The transition is `transition-colors` (motion-language ratchet —
 * duration MUST enumerate the property, never `transition-all`).
 */

import Link from 'next/link';
import type { CSSProperties } from 'react';
import type { LucideIcon } from 'lucide-react';
import { StatusBadge } from '@/components/ui/status-badge';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';
import { useSidebarCollapsed } from './sidebar-collapse-context';

// ─── Geometry tokens (R12-PR2) ─────────────────────────────────────
//
// Five measurements drive the way a nav item feels in the hand. Each
// is a named constant so the rationale lives next to the value. A
// future "just bump padding by 2px" PR has to argue against both the
// doc-comment and the ratchet at
// `tests/guards/nav-item-geometry-discipline.test.ts`.

/**
 * **Row height — 44px touch / 34px desktop.** WCAG 2.5.5 (Target Size)
 * wants a 44×44 CSS-px minimum for TOUCH; NavItem renders in the mobile
 * drawer, so the base stays `min-h-[44px]`. On desktop (`md:`) the nav is
 * pointer-driven, where 44px reads as oversized — `md:min-h-[34px]` tightens
 * the sidebar rows (Board / Asset / Risk / …) without sacrificing the mobile
 * touch target.
 */
export const NAV_ITEM_HEIGHT_MIN = 'min-h-[44px] md:min-h-[34px]';

/**
 * **px-3, py-2.5 touch / py-1.5 desktop.** Horizontal: the active state's 2px
 * brand left-edge eats 2px of left padding so content still sits at the
 * geometric 12px. Vertical: 10px on touch keeps the row at the 44px target;
 * on desktop `md:py-1.5` (6px) pairs with `md:min-h-[34px]` for a compact row.
 */
export const NAV_ITEM_PADDING = 'px-3 py-2.5 md:py-1.5';

/**
 * **gap-compact** — 8px between icon and label.
 * Tighter (6px) makes the icon glue to the label; wider (12px)
 * floats them apart in a way that reads as carelessness. 8 is the
 * Goldilocks for an 18px icon + 14px label.
 */
export const NAV_ITEM_GAP = 'gap-compact';

/**
 * **rounded-lg** — 8px corner radius.
 * Parity with the `<Button>` primitive (`buttonVariants` rests at
 * rounded-lg). Mixing 8 / 6 / 12 across primary chrome reads as
 * un-decided. Pick one for the row family, hold it.
 */
export const NAV_ITEM_RADIUS = 'rounded-lg';

/**
 * **28×28 icon.** Sized up from 18 so the glyph carries the row (the labels
 * shrank with the compact rows) and, crucially, fills the collapsed icon-rail
 * properly — an 18px icon looked lost in the 56px rail. 28px = `h-7 w-7`.
 */
export const NAV_ITEM_ICON_SIZE = 'h-7 w-7';

/**
 * Icon class — full recipe. (R12-PR9 lock.)
 *
 * Two tokens, both load-bearing:
 *
 *   (1) `NAV_ITEM_ICON_SIZE` — 18×18, the geometry above.
 *
 *   (2) `flex-shrink-0` — the icon MUST hold its 18×18 box.
 *       Without this, on a row with a very long label and a
 *       narrow sidebar, flex would steal pixels from the icon
 *       too, rendering a squished 14×18 lozenge. The icon is the
 *       row's anchor — geometry has to be unconditional.
 *
 * The icon is `aria-hidden="true"` at the JSX layer (not in this
 * class string). The label is the accessible name; the icon is
 * decorative. Screen readers announce "Practices", not "icon
 * Practices". This is the right semantic and is locked by the
 * R12-PR9 ratchet.
 *
 * Why a named const (not inline)?
 *   - The R12 pattern: every state recipe is a named export so
 *     the rationale + the ratchet both anchor on the same name.
 *   - A future "let's add a hover:scale-110 to the icon" PR has
 *     to argue against both the doc-comment and the ratchet,
 *     not just edit a string literal.
 */
export const NAV_ITEM_ICON_CLASS = `${NAV_ITEM_ICON_SIZE} flex-shrink-0`;

export interface NavItemProps {
    /** Tenant-prefixed href. */
    href: string;
    /** Lucide icon component (rendered at 18×18). */
    icon: LucideIcon;
    /** Visible label. Truncates on overflow. */
    label: string;
    /** Whether this item is the current page. Drives the active state. */
    active: boolean;
    /** Optional count chip (e.g. calendar upcoming-event count). */
    badge?: string | number;
    /** Optional click handler — used by the mobile drawer to close itself. */
    onClick?: () => void;
}

/**
 * **The brand-gradient band** — R12-PR5, evolved by R13-PR2.
 *
 * A 3-px wide capsule-shaped pseudo-element pinned to the left of
 * the row. The R12 recipe was a 2-stop gradient (brand-default →
 * brand-emphasis); R13-PR2 evolves this to a **3-stop gradient
 * with a highlight midstop** — like brushed metal lit from above:
 *
 *     top    `--brand-default`  (canonical brand)
 *     middle `--brand-muted`    (one rung lighter — the "highlight")
 *     bottom `--brand-emphasis` (one rung deeper — the "shadow")
 *
 * The eye reads this as a polished metallic capsule with a
 * deliberate highlight bar across its middle. The single-tone
 * "fluid deepening" of R12 was honest but flat; R13-PR2 adds the
 * shape of light hitting the band, which is what "alive" feels
 * like to the eye.
 *
 * Pair with a soft outer glow (`--nav-band-glow` from tokens.css,
 * resolved per theme — yellow @ 35% on METRO, orange @ 35% on
 * PwC). The glow bleeds 6px of brand-coloured light into the row
 * surface, softening the band's edge so it doesn't read as a
 * stamped line. "No rough edges" turns into "the band has an
 * aura".
 *
 * Why a pseudo-element, not a border-left?
 *   - `border-image: linear-gradient(...)` works but doesn't
 *     animate opacity cleanly across browsers.
 *   - A real `<span>` adds DOM weight + a tab-stop edge case.
 *   - Pseudo-element is the canonical CSS recipe for decorative
 *     state signals (no DOM, no a11y noise, full transition
 *     practice).
 *
 * Why 6px inset top/bottom (`top-1.5 bottom-1.5`)?
 *   - Full-height rules feel architectural (a divider). A
 *     CAPSULE feels like jewellery. The band reads as a piece of
 *     deliberate ornament, not row chrome.
 *
 * Why opacity 0 → 1 transition (R12-PR5 invariant, preserved)?
 *   - Opacity is the canonical "fade in/out" motion for tone-only
 *     design systems. 200ms ease-out is one rung slower than the
 *     row's colour transition (150ms) so the band feels like it
 *     lights up just AFTER the text wakes — a tiny choreography
 *     the eye doesn't consciously notice but reads as deliberate.
 *
 * The DEFAULT state holds the band at opacity 0 — invisible.
 * The HOVER state fades it to opacity 100 — visible.
 * The ACTIVE state holds it at opacity 100 + adds a brand-subtle
 * background for conviction (see NAV_ITEM_ACTIVE).
 */
/**
 * **The gloss highlight** — R13-PR6.
 *
 * A 1-px tall horizontal line on the `<NavItem>` row's top edge,
 * rendered via the `::after` pseudo-element. Mirrors the way light
 * catches the top edge of a physical raised button. Pinned 8px from
 * each side (`left-2 right-2`) so it doesn't run all the way to the
 * row's corners — keeps the gloss looking like a deliberate
 * highlight rather than a hairline divider.
 *
 * Resolved per theme via `--nav-gloss-highlight`:
 *   METRO  rgba(255, 255, 255, 0.08)  — subtle white catch on navy
 *   PwC    rgba(255, 255, 255, 0.70)  — near-white sliver on cream
 *
 * Opacity 0 by default; fades to 100 on hover + active (200ms
 * ease-out — same tempo as the band). Pointer-events disabled so
 * the gloss never intercepts clicks. Geometry is unchanged across
 * states; only opacity moves — preserves R12's motion-language
 * contract (the gloss is opacity + colour, no transform).
 *
 * The gloss is the second `::after`-style decoration the row owns
 * (the band is `::before`). Together they wrap the row in two
 * "lit" edges — the left band signals state, the top gloss signals
 * "raised, ready". Why not a fuller bevel (bottom shadow too)?
 * Because that's PR-7's job — keeping these stacked PRs single-
 * concern.
 */
const NAV_ITEM_GLOSS_BASE = [
    // Pinned 8px from each side, hairline tall.
    'after:absolute after:left-2 after:right-2 after:top-0 after:h-px',
    // Theme-aware highlight tone.
    'after:bg-[var(--nav-gloss-highlight)]',
    // Soft ends so the highlight doesn't terminate as a square stamp.
    'after:rounded-full',
    // Decoration only — never captures clicks.
    'after:pointer-events-none',
    // Opacity-only motion, same tempo as the band.
    'after:opacity-0 after:transition-opacity after:duration-200 after:ease-out',
].join(' ');

const NAV_ITEM_BAND_BASE = [
    'before:absolute before:left-0 before:top-1.5 before:bottom-1.5',
    'before:w-[3px] before:rounded-r-full',
    // R15-PR1 — stardust particle trail. The band's bg-image stacks
    // THREE white radial-gradient "particles" on top of the
    // R13-PR2 3-stop brand-gradient base. Each particle is a small
    // (1.5px) circle of white at a fading alpha — the leading
    // particle is bright, the trailing ones dim out like a comet
    // tail. As the existing `nav-band-shimmer` animation pans the
    // bg-position, the entire stack drifts along the band's length;
    // the particles READ as a glittering trace following the brand
    // gradient.
    //
    // Why white instead of brand-coloured?
    //   Brand-coloured particles disappear against the brand
    //   gradient. White at low alpha reads as "starlight" — visible
    //   at peripheral vision without competing with the band's hue
    //   palette. Same hue-strategy as the gloss highlight (R13-PR6).
    //
    // The R13-PR2 ratchet still passes because the linear-gradient
    // portion preserves `var(--brand-default)`, `var(--brand-muted)`,
    // `var(--brand-emphasis)` in `from → via → to` order — the
    // radial-gradients are stacked ABOVE it in z-order without
    // displacing any stop.
    'before:bg-[radial-gradient(circle_1.5px_at_50%_80%,_rgba(255,255,255,0.9),_transparent_70%),radial-gradient(circle_1.5px_at_50%_55%,_rgba(255,255,255,0.5),_transparent_70%),radial-gradient(circle_1.5px_at_50%_30%,_rgba(255,255,255,0.2),_transparent_70%),linear-gradient(to_bottom,_var(--brand-default),_var(--brand-muted),_var(--brand-emphasis))]',
    // R13-PR3 — `background-size: 100% 200%` makes the gradient
    // twice the band's height, so the `nav-band-shimmer` keyframe
    // can pan it along its own length. Without this the gradient
    // would already cover 100% of the band and the pan would be a
    // no-op. The shimmer animation itself is gated to hover + active
    // (see NAV_ITEM_DEFAULT / NAV_ITEM_ACTIVE) — running while the
    // band is opacity-0 would waste CPU on every sidebar row.
    'before:[background-size:100%_200%]',
    // Outer glow — `--nav-band-glow` resolves per theme to the
    // brand hue at 35% over a 6px blur. Softens the band's edges
    // into a halo, fixing the "stamped line" feel of the R12
    // recipe. Static across states — the glow is part of the band's
    // form, not gated on hover/active.
    'before:shadow-[var(--nav-band-glow)]',
    // R13-PR9 — the transition property list expands beyond R12's
    // opacity-only to include `top`, `bottom`, `width`. When the
    // band reaches toward the cursor on hover (top-1.5 → top-1,
    // bottom-1.5 → bottom-1, w-3px → w-4px), the geometry change
    // animates with the same 200ms ease-out as the opacity reveal.
    // Single shared duration keeps the band feeling like one piece
    // of choreography rather than two timed animations.
    'before:opacity-0 before:transition-[opacity,top,bottom,width] before:duration-200 before:ease-out',
].join(' ');

/**
 * Geometry + structural-state base — shared by every state. The
 * five geometry tokens above compose into this string; the
 * remaining tokens are structural (flex / text size / motion /
 * focus ring / brand-gradient band pseudo-element).
 */
export const NAV_ITEM_BASE = [
    // `relative` anchors the brand-gradient `::before` band.
    // `group` lets the child label `<span>` react to hover on the
    // PARENT row — required for the R15-PR8 magnetic-letter
    // tracking (the label's `letter-spacing` opens up via
    // `group-hover:tracking-wide`).
    'relative flex items-center group',
    NAV_ITEM_GAP,
    NAV_ITEM_PADDING,
    NAV_ITEM_HEIGHT_MIN,
    NAV_ITEM_RADIUS,
    'text-sm transition-colors duration-150 ease-out',
    // R13-PR8 — press feedback. Single tactile micro-motion the
    // R13 vocabulary explicitly allows: on mousedown the row drops
    // 1px (`active:translate-y-px`), the universal "you just
    // clicked something physical" cue. Paired with a fast 75ms
    // transition on transform so the down-press feels snappy and
    // the spring-back on mouseup is barely-perceptible. Geometry
    // returns to baseline the instant the click ends — no
    // lingering displacement.
    //
    // R15-PR10 — weighty press feedback. R13-PR8's 1px translate
    // gave the click a "you pressed something" cue. R15-PR10 adds
    // a 1% scale-down (`active:scale-[0.99]`) that fires
    // CONCURRENTLY on the same mousedown. The combination reads
    // as a real physical button compressing AND moving down — two
    // dimensions of tactile feedback in 75ms.
    //
    // Why 0.99 (not 0.95)? A larger scale would visibly shrink
    // the row's text and icon, which feels like "the row is
    // running away from the cursor". 0.99 is just enough that
    // the eye registers the compression without the content
    // changing perceivably. Combined with the 1px translate, it's
    // the canonical "real button" feedback every premium product
    // converges on.
    //
    // These two transforms are the ONLY transforms the sidebar
    // allows. Hover lift, scale-on-hover, translate on focus —
    // all still banned. The mousedown press is the canonical
    // "real button" feedback; anything else is decorative motion
    // that the R12 motion-language ratchet correctly rejects.
    //
    // Both transforms have explicit `motion-reduce:` overrides
    // that snap them back to identity (`scale-100` / `translate-
    // y-0`). Users who've opted out of motion at the OS level
    // get a static row — no displacement, no compression. The
    // motion-reduce override on EACH transform property
    // independently is load-bearing: without the scale override,
    // a motion-reduced user would still get the 1% compression.
    'transition-transform duration-75 ease-out active:translate-y-px active:scale-[0.99] motion-reduce:active:translate-y-0 motion-reduce:active:scale-100',
    NAV_ITEM_BAND_BASE,
    NAV_ITEM_GLOSS_BASE,
    // Focus-visible — keyboard story. (R12-PR7 lock.)
    //
    // Four tokens, no more, no less:
    //
    //   `focus-visible:outline-none`
    //       Suppress the user-agent default outline (varies by
    //       browser — Firefox dashes, Chrome solids, Safari skips).
    //       The ring below replaces it with one we own.
    //
    //   `focus-visible:ring-2`
    //       2px ring. 1px is invisible on common hi-DPI rendering;
    //       3px reads as "alarm". 2 is the keyboard-canonical
    //       thickness shared by every focus-visible surface in
    //       the codebase.
    //
    //   `focus-visible:ring-[var(--ring)]`
    //       The canonical focus tone — brand yellow at ~55% alpha
    //       (METRO theme) or brand orange at ~40% (PwC theme). The
    //       same token every other focusable primitive uses. NEVER
    //       a hard brand fill — focus signals "the keyboard knows
    //       you're here", not "the system has changed".
    //
    //   `focus-visible:ring-offset-2 focus-visible:ring-offset-bg-default`
    //       2px gap between the row and the ring, filled with the
    //       sidebar's `bg-bg-default` surface. The ring then
    //       floats one breath off the row, instead of touching
    //       its rounded corners. That breath is what makes the
    //       focus state look DELIBERATE — not an accident of the
    //       browser default.
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-bg-default',
].join(' ');

/**
 * Default state — humble, ready, quiet. (R12-PR5 evolution.)
 *
 * R12-PR4 had `hover:bg-bg-muted` as the hover signal — a solid
 * full-row tint. R12-PR5 retires that. The hover signal is now
 * the brand-gradient band on the left (see `NAV_ITEM_BAND_BASE`),
 * which appears via the `::before` opacity-0 → opacity-100
 * transition.
 *
 * What hover STILL changes:
 *   - text: `text-content-muted` → `text-content-emphasis`
 *     (one rung brighter — the label wakes up).
 *   - band: opacity 0 → 100 (the brand-gradient ornament).
 *
 * What hover NO LONGER changes:
 *   - background: stays transparent. The full-row bg felt
 *     "claimed" — like the row was being asserted on. The band
 *     is a quieter "noticed" — the row is acknowledged, not
 *     conquered.
 *
 * No `transform`, no `scale`, no `translate`. Motion is opacity +
 * colour only — locked by the motion-language ratchet.
 */
export const NAV_ITEM_DEFAULT =
    'text-content-muted hover:text-content-emphasis hover:after:opacity-100 hover:shadow-[var(--nav-bevel-shadow)] hover:bg-[linear-gradient(135deg,_transparent_30%,_var(--nav-row-liquid-tint)_50%,_transparent_70%)] hover:[background-size:300%_100%] hover:animate-nav-row-liquid-sweep';

/**
 * Active state — conviction. (R12-PR6 lock, R13-PR4 evolution,
 * 2026-05-13 band-tone-swap evolution.)
 *
 * The active row tells you which page you're on. It has to read
 * as "settled" — not louder than the surrounding rows, not
 * quieter. R12-PR6 expressed conviction through four cooperating
 * tokens (text-content-emphasis + brand-subtle bg + opacity-100
 * band + font-medium). R13-PR4 added a FIFTH dimension: the
 * band's gradient swapped to the secondary brand (cool blue/navy).
 *
 * 2026-05-13 — the user asked to invert the band's two-tone
 * vocabulary: the active band should now resolve to the PAGE
 * BACKGROUND tone (navy on dark, warm grey on light), so the
 * active row reads as a CUT-OUT of the sidebar surface revealing
 * the page beneath. The hover band keeps its primary-brand
 * tone (yellow on dark, orange on light). Net two tones:
 *
 *   default hover  brand-default ramp (yellow / orange)
 *   active         --bg-page (navy / warm grey)
 *
 * Five cooperating tokens, no single one shouting:
 *
 *   (1) `text-[var(--brand-default)]` (R13-PR5)
 *       Brand-coloured letters: yellow on METRO, orange on PwC.
 *       Held permanently on the active row. The active page is now
 *       visually unmissable from across the desk — the band tells
 *       you WHERE, the brand-coloured label tells you WHAT.
 *       Both themes clear WCAG AA: Agrent gold `#D4AF37` on a
 *       deep-navy + 16%-gold wash reads at >8:1; dark goldenrod
 *       `#B8860B` on cream + 16%-gold wash at ~4.6:1.
 *
 *   (2) Radial brand-secondary wash (R13-PR11 evolution)
 *       `bg-[radial-gradient(circle_at_left, --brand-secondary-
 *       subtle, transparent 75%)]`. Originally the wash was a
 *       uniform `bg-[var(--brand-subtle)]` (warm primary tint).
 *       R13-PR11 evolved it to a radial gradient ORIGINATING from
 *       the band's left edge, fading to transparent at the right.
 *       The navy radial bleeds out from the band — feels like the
 *       band is leaking light into the row. The wash is now COOL
 *       (matches the band's hue family), not WARM as in R12-PR6;
 *       the warm/cool contrast moved to band-cool + label-warm
 *       (label is `text-[var(--brand-default)]`).
 *
 *   (3) `before:opacity-100 before:animate-nav-band-alive`
 *       Band held visible permanently + composed alive-motion
 *       (R15-PR2): `nav-band-alive` chains the 4-second shimmer
 *       pan and the 6-second halo-breath brightness pulse onto
 *       the same `::before`. The 4s/6s mismatch (LCM 12s) means
 *       the two timelines never re-sync for any glance shorter
 *       than 12 seconds — the band reads as continuously
 *       evolving rather than mechanically looping.
 *
 *   (4) Page-bg band override (R13-PR4 → 2026-05-13 v2)
 *       The BASE recipe paints the band via a single
 *       comprehensive `before:bg-[radial-gradient(...) ×3,
 *       linear-gradient(to_bottom, brand-default, brand-muted,
 *       brand-emphasis)]` arbitrary value. Tailwind's utility
 *       `before:from-X!` / `before:via-X!` / `before:to-X!`
 *       overrides only set the `--tw-gradient-from/via/to` CSS
 *       variables; they DON'T override the literal arbitrary
 *       `background-image` value above. The R13-PR4 brand-
 *       secondary swap silently failed for that reason — the
 *       brand-default ramp from BASE always won.
 *
 *       The fix (2026-05-13 v2) is to override the ENTIRE
 *       `before:bg-[...]` arbitrary value with a parallel
 *       arbitrary value carrying the page-bg tones. Three
 *       identical `var(--bg-page)` stops collapse the linear
 *       gradient to a solid; the stardust particle layers are
 *       preserved verbatim. The `!` important still wins over
 *       the BASE recipe's bg-image because both forms compile
 *       to `[&]:before:background-image: ...` and `!` raises
 *       the active variant's specificity.
 *
 *       The glow is preserved as `--nav-band-glow-active`
 *       (navy blur) — it still anchors the band's edge softly
 *       into the sidebar surface.
 *
 *   (5) `font-medium`
 *       One weight up from regular (400 → 500). Anything bolder
 *       reads as a heading.
 *
 * Visual progression — default → hover → active:
 *   default  no band, muted text, no bg
 *   hover    primary-brand band fades in (warm yellow/orange)
 *            text brightens to content-emphasis
 *   active   primary-brand wash + SECONDARY-brand band (cool)
 *            + BRAND-COLOURED text + font-medium + shimmer pulse
 *
 * R13-PR4 ratchet at
 * `tests/guards/r13-active-band-secondary.test.ts` locks the
 * five secondary-brand override classes + the navy-glow plumbing.
 */
export const NAV_ITEM_ACTIVE =
    'text-[var(--brand-default)] bg-[radial-gradient(circle_at_left,_var(--brand-secondary-subtle),_transparent_75%)] before:opacity-100 before:animate-nav-band-active-alive before:top-1! before:bottom-1! before:w-[4px]! before:bg-[radial-gradient(circle_1.5px_at_50%_80%,_rgba(255,255,255,0.9),_transparent_70%),radial-gradient(circle_1.5px_at_50%_55%,_rgba(255,255,255,0.5),_transparent_70%),radial-gradient(circle_1.5px_at_50%_30%,_rgba(255,255,255,0.2),_transparent_70%),linear-gradient(to_bottom,_var(--bg-page),_var(--bg-page),_var(--bg-page))]! before:shadow-[var(--nav-band-glow-active)]! after:opacity-100 shadow-[0_0_12px_2px_var(--nav-row-aura-color),var(--nav-bevel-shadow)] font-medium';

/**
 * Badge recipe — aligned + breathing. (R12-PR8 lock.)
 *
 * Optional count chip (e.g. calendar's upcoming-event count). Five
 * tokens, each carrying its own load:
 *
 *   (1) `ml-auto`
 *       Pushes the badge to the row's right edge. The icon + label
 *       sit on the left, the badge floats on the right. Margin-auto
 *       (not flex-end) so the label can still occupy the natural
 *       middle space and truncate gracefully when long.
 *
 *   (2) `tabular-nums`
 *       Numerals render at fixed width. A count going 9 → 10 →
 *       99 → 100 doesn't make the badge "pop wider" on every change.
 *       The badge keeps a stable rectangle the eye trusts.
 *
 *   (3) `flex-shrink-0`
 *       The badge MUST NOT be the thing that shrinks when a row's
 *       label is long. The label has `truncate`; the badge is the
 *       fixed counterweight. Without this, on a row like
 *       "Vendor Risk Assessments (47)" with a narrow sidebar, flex
 *       would steal width from the badge too.
 *
 *   (4) `animate-in fade-in`
 *       Tailwindcss-animate's enter animation primitive — opacity
 *       0 → 100 on initial mount. The conditional `{badge != null
 *       && ...}` mounts/unmounts the badge naturally: when a count
 *       first appears (null → 3), the badge fades in. When it
 *       changes value (3 → 4), the element stays mounted and the
 *       animation does NOT re-fire. The entrance is the breath;
 *       updates are silent. Same motion language as the band:
 *       opacity only, no transform / scale / translate.
 *
 *   (5) `duration-300`
 *       The breath has a measured tempo. 300ms is one rung slower
 *       than the band's 200ms — the badge arrives just after the
 *       row finishes settling, which reads as deliberate
 *       choreography rather than competing motion.
 *
 * The badge variant + size + tone are chosen by the JSX, not by
 * this recipe: `variant="info"` (blue, neutral signal — never a
 * brand tone that would compete with the active state's
 * brand-subtle wash) and `size="sm"` (10px text — quiet, doesn't
 * crowd the 14px label or the 18px icon).
 */
export const NAV_ITEM_BADGE =
    'ml-auto tabular-nums flex-shrink-0 animate-in fade-in duration-300';

/**
 * R15-PR5 — asymmetric per-row drift.
 *
 * Without staggering, every row's shimmer + halo-breath start at
 * the same phase. The sidebar's bands then march in lockstep —
 * easy for the eye to read as "a periodic system", which makes
 * the carefully-tuned R15 motion feel mechanical despite the
 * mismatched 4s/6s tempos.
 *
 * The fix is per-row `animation-delay` on the two PERPETUAL
 * tracks (shimmer + halo-breath). The two ONE-SHOT tracks
 * (reveal-sweep + starburst) keep zero delay because they're
 * celebration moments that need to fire instantly when the row
 * engages — staggering them would smear the "you just clicked"
 * signal across half a second.
 *
 * Delays are derived from a deterministic hash of the row's
 * slug. Same slug → same delay across renders, so the visual
 * "pattern" of phase offsets stays stable while the user
 * navigates. A different hash bucket for each of the two perpetual
 * tracks means the per-row phase pair is genuinely independent —
 * no two rows have the same (shimmer-phase, breath-phase) coord.
 *
 * The shimmer hash returns 0..999 ms (just under one full
 * shimmer cycle of 4s ÷ 4 = a quarter cycle), and the breath
 * hash returns 0..1499 ms (a quarter of the 6s halo-breath
 * cycle). Quarter-cycle staggers are the visual sweet spot —
 * rows are clearly out of phase without any pair looking like
 * exact mirrors.
 */
function hashSlugToDriftDelays(slug: string): {
    shimmerDelayMs: number;
    breathDelayMs: number;
} {
    let h = 0;
    for (let i = 0; i < slug.length; i++) {
        h = (h * 31 + slug.charCodeAt(i)) | 0;
    }
    const abs = Math.abs(h);
    return {
        shimmerDelayMs: abs % 1000,
        breathDelayMs: (abs >> 4) % 1500,
    };
}

export function NavItem({ href, icon: Icon, label, active, badge, onClick }: NavItemProps) {
    const slug = href.split('/').pop() ?? '';
    const { shimmerDelayMs, breathDelayMs } = hashSlugToDriftDelays(slug);
    const driftStyle = {
        // CSS custom properties consumed by the per-track
        // animation-delay slots inside `nav-band-alive` and
        // `nav-band-active-alive`. Both names land on the
        // `<Link>` host element; CSS custom properties inherit
        // into the `::before` pseudo where the animation runs.
        '--nav-shimmer-delay': `${shimmerDelayMs}ms`,
        '--nav-breath-delay': `${breathDelayMs}ms`,
    } as CSSProperties;

    // Collapsed (desktop icon-rail) — center the icon, drop the label + badge
    // chip, and surface the label as a right-side tooltip so the rail stays
    // navigable. `useSidebarCollapsed` is `false` in the mobile drawer + when no
    // provider is mounted, so the expanded path is the default.
    const collapsed = useSidebarCollapsed();

    const link = (
        <Link
            href={href}
            // Force a FULL-RSC prefetch (not just the loading-boundary slice
            // Next prefetches by default for `force-dynamic` routes). The
            // sidebar is always in the viewport, so every hot route prefetches
            // its RSC into the client router cache on mount; combined with the
            // 30s `staleTimes.dynamic` (next.config.js) the click renders from
            // cache instead of paying the server round-trip — the "instant
            // nav" lever. Background prefetch cost is bounded by the SSR cache.
            prefetch
            onClick={onClick}
            className={cn(
                NAV_ITEM_BASE,
                active ? NAV_ITEM_ACTIVE : NAV_ITEM_DEFAULT,
                collapsed && 'justify-center',
            )}
            data-testid={`nav-${slug}`}
            style={driftStyle}
            aria-label={collapsed ? label : undefined}
        >
            <Icon className={NAV_ITEM_ICON_CLASS} aria-hidden="true" />
            {/* R15-PR8 — magnetic letter spacing. The label
                breathes its tracking open on hover-of-the-row.
                `tracking-normal` is the resting state (0em);
                `group-hover:tracking-wide` opens to 0.025em —
                small enough that the row's geometry stays
                stable (the label still fits in the same width
                bucket; `truncate` semantics unchanged), large
                enough that the eye reads the letters subtly
                "leaning into" the cursor. 200ms ease-out
                transition keeps the open synchronised with the
                band's reveal tempo. The shape is opacity + tone
                language inside the row's content — no transform,
                no scale, no translate. */}
            {!collapsed && (
                <span className="truncate tracking-normal transition-[letter-spacing] duration-200 ease-out group-hover:tracking-wide">
                    {label}
                </span>
            )}
            {!collapsed && badge != null && (
                <StatusBadge variant="info" size="sm" className={NAV_ITEM_BADGE}>
                    {badge}
                </StatusBadge>
            )}
        </Link>
    );

    return collapsed ? (
        <Tooltip content={label} side="right">
            {link}
        </Tooltip>
    ) : (
        link
    );
}
