'use client';

/**
 * Roadmap-12 PR-3 — `<NavSection>` primitive.
 *
 * Groups a set of `<NavItem>`s under an optional section header
 * (Govern / Comply / Manage). The header is the chiselled-in
 * label — unmarkable, quiet, definite — that defines a section
 * without shouting.
 *
 * Why a separate file from `nav-item.tsx`:
 *
 *   - `NavSection` is the parent composition unit; `NavItem` is
 *     the leaf. Keeping them in sibling files makes the contract
 *     boundary obvious — section-level recipe lives here, row-level
 *     recipe lives there.
 *   - Future PRs that polish the section header (R12 doesn't go
 *     further; later UI work might) edit ONE file.
 *
 * Section header recipe (R12-PR3):
 *
 *   - `<span>`, not `<p>`. No default `cursor: text`. Reads as
 *     decorative, not selectable.
 *   - `select-none` belt-and-braces — double-click can't highlight
 *     "Govern" / "Comply" / "Manage".
 *   - `text-[10px]` — one click smaller than the canonical Eyebrow.
 *     The sidebar's typographic hierarchy is row label (14px) >
 *     section header (10px) > app brand (14px). Section header is
 *     a whisper, not a headline.
 *   - `tracking-[0.12em]` — letter-spacing that reads as
 *     "deliberate" not "stretched". 0.1em is too tight, 0.16em
 *     feels overconfident at small sizes.
 *   - `text-content-subtle` — one rung quieter than the page-level
 *     Eyebrow. Section headers are scaffolding; row labels are
 *     content.
 *   - 1px soft gradient hairline above (R13-PR10 evolution from
 *     R12-PR3's flat `border-border-subtle/40`). The divider now
 *     fades in from transparent at the row edges to
 *     `--border-subtle` at center and back to transparent —
 *     `linear-gradient(90deg, transparent, --border-subtle,
 *     transparent)`. The fade reads as breath, not architecture;
 *     section breaks feel like the sidebar inhaling, not as
 *     architectural seams stamped into chrome.
 *     Skipped on the FIRST section so the very top of the sidebar
 *     doesn't pick up an accidental rule.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { ChevronRight } from '@/components/ui/icons/nucleo/chevron-right';
import { useSidebarCollapsed } from './sidebar-collapse-context';

export interface NavSectionProps {
    /**
     * Section title. Renders as a `<span>` (no text cursor) with
     * `select-none` (no highlight on double-click). When omitted,
     * the section renders just its children (used for the solo
     * Board home-link group).
     */
    title?: string;
    /**
     * Whether this section is the first one in the sidebar.
     * Suppresses the top hairline so the very top of the sidebar
     * doesn't pick up an accidental rule. Default: false.
     */
    isFirst?: boolean;
    /**
     * Foldable-section evolution. When `true` (AND the sidebar is
     * expanded AND a `title` exists), the header becomes a disclosure
     * `<button>` that folds/unfolds the section's items. The header
     * text keeps its `NAV_SECTION_HEADER` recipe as an inner `<span>`
     * — only the surrounding button carries the click-target
     * affordance. Default `false` (the org sidebar / any non-foldable
     * caller renders the plain decorative header as before).
     */
    collapsible?: boolean;
    /**
     * Controlled open state. Only meaningful when `collapsible`.
     * When folded, the section's items are not rendered. Default
     * `true` so a non-collapsible section always shows its items.
     */
    open?: boolean;
    /** Toggle handler fired by the disclosure button. */
    onToggleOpen?: () => void;
    children: ReactNode;
}

/** Section header — the recipe locked by R12-PR3. */
// pt-1.5 (was pt-4) — the section name sits just under the divider hairline
// instead of floating ~24px below it, killing the dead space between groups.
export const NAV_SECTION_HEADER =
    'block px-3 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-content-subtle select-none';

/**
 * Disclosure-button wrapper for a FOLDABLE section header.
 *
 * The header text keeps its `NAV_SECTION_HEADER` recipe (10px,
 * tracking-0.12em, select-none) as an inner `<span>`; this const owns
 * ONLY the button's layout + click-target affordance, so the two
 * concerns stay separable and the R12-PR3 typography ratchet still
 * reads the untouched header recipe.
 *
 *   - `hover:bg-bg-muted` — the canonical CLICK-TARGET hover recipe
 *     (R5-PR5), not the row/card `/50`. A section header you tap is a
 *     button, not a hoverable row.
 *   - `min-h-[32px]` — a comfortable tap target in the mobile drawer
 *     (clears the 24px WCAG 2.5.8 floor with headroom) while staying
 *     compact on desktop. The header text's own pt-1.5/pb-1 gives
 *     ~24px; the min-h pads it to a confident 32.
 *   - `pr-2` — right inset for the chevron (the header text supplies
 *     the left inset via its `px-3`).
 *   - canonical focus ring + `transition-colors duration-150`
 *     (motion-language: enumerate the property, never `transition-all`).
 */
export const NAV_SECTION_HEADER_BUTTON =
    'group flex w-full items-center justify-between rounded-md pr-2 min-h-[32px] hover:bg-bg-muted transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]';

/**
 * Soft-gradient hairline above the section (skipped on the first
 * section). R13-PR10 replaces the R12-PR3 hard `border-t border-
 * border-subtle/40` with a `::before` pseudo-element carrying a
 * horizontal gradient that fades from transparent at each edge to
 * `--border-subtle` at center.
 *
 * Why not just `border-image: linear-gradient(...)`?
 *   - `border-image` works but doesn't support the `border-style`
 *     alpha tuning we relied on with `/40`. A `::before` overlay
 *     gives full practice over both the line's shape and its
 *     opacity profile.
 *
 * Why peak at `--border-subtle` (not `/40`)?
 *   - `--border-subtle` is already alpha-tuned per theme (METRO
 *     navy @ 50%, PwC warm gray @ 60%). The gradient fade at edges
 *     drops effective brightness to ~25-30% at peak — quieter than
 *     R12-PR3's flat ~20%, but the in-and-out fade is what makes
 *     it feel like breath rather than rule.
 *
 * Why absolute-positioned `::before` (not block)?
 *   - The line sits on the wrapper's exact top edge regardless of
 *     content. A `before:block before:h-px` flow-positioned approach
 *     would push content down by 1px on the divided sections only,
 *     creating a 1px alignment drift between first-section
 *     (undivided) and later sections (divided).
 */
export const NAV_SECTION_DIVIDER =
    'relative mt-1.5 pt-1.5 before:absolute before:top-0 before:left-0 before:right-0 before:h-px before:bg-[linear-gradient(90deg,_transparent,_var(--border-subtle),_transparent)]';

export function NavSection({
    title,
    isFirst = false,
    collapsible = false,
    open = true,
    onToggleOpen,
    children,
}: NavSectionProps) {
    // Collapsed icon-rail: drop the text header (it would overflow the narrow
    // rail) but keep the top divider on titled sections so the Govern / Comply /
    // Manage groups still read as distinct bands.
    const collapsed = useSidebarCollapsed();
    // The disclosure only engages in the EXPANDED sidebar on a TITLED section.
    // The collapsed icon-rail has no headers, so it always shows every item.
    const isDisclosure = collapsible && !collapsed && Boolean(title);
    const childrenHidden = isDisclosure && !open;
    return (
        <div className={cn(!isFirst && title && NAV_SECTION_DIVIDER)}>
            {title && !collapsed && (
                isDisclosure ? (
                    <button
                        type="button"
                        onClick={onToggleOpen}
                        aria-expanded={open}
                        className={NAV_SECTION_HEADER_BUTTON}
                    >
                        <span className={NAV_SECTION_HEADER}>{title}</span>
                        <ChevronRight
                            aria-hidden="true"
                            className={cn(
                                'size-3 shrink-0 text-content-subtle transition-transform duration-150',
                                open && 'rotate-90',
                            )}
                        />
                    </button>
                ) : (
                    <span className={NAV_SECTION_HEADER}>
                        {title}
                    </span>
                )
            )}
            {!childrenHidden && <div className="space-y-0.5">{children}</div>}
        </div>
    );
}
