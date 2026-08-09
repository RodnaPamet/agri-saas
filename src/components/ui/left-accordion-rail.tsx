'use client';

/**
 * B7 — Left accordion rail.
 *
 * A docked left-side orientation pane that organises the
 * adjacent table into sections. Per-table the rail surfaces a
 * curated set of section groupings (e.g. "Status", "Framework",
 * "Owner") — each section is collapsed by default and expands on
 * an explicit user click. Inside an expanded section, the values
 * act as filter chips that route through the standard
 * `useFilterContext` state.
 *
 * Design constraints (per the user's brief):
 *
 *   • Quiet by default. No coloured banding, no hover-trigger
 *     expansion, no "this is the loudest thing on the page"
 *     attention pulls. The rail is a navigation companion, not a
 *     hero element.
 *
 *   • Click-only expand. No hover / focus auto-open semantics —
 *     opening a section is a deliberate gesture. Keyboard:
 *     ArrowUp / ArrowDown move between section triggers; Enter /
 *     Space toggles the focused one.
 *
 *   • External to the table's natural border. The rail sits in
 *     its own column with a `gap-section` separation from the
 *     table card — it never reads as embedded chrome.
 *
 *   • Orientation, not decoration. Each section organises the
 *     table's rows by a meaningful axis; clicking a value filters
 *     the table to that subset. Pure visual sections without a
 *     filter action would defeat the orientation purpose.
 *
 * The primitive owns the shell + the open/closed state machine.
 * Consumers describe their sections declaratively via
 * `<LeftAccordionRail sections={...} />`; per-section content
 * (the value list, the click handlers) is the caller's domain
 * knowledge.
 */
import {
    useEffect,
    useId,
    useState,
    useCallback,
    type KeyboardEvent,
    type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRight } from '@/components/ui/icons/nucleo/chevron-right';
import { ChevronLeft } from '@/components/ui/icons/nucleo/chevron-left';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';

// ─── Public types ──────────────────────────────────────────────────

export interface LeftAccordionRailSection {
    /** Stable identifier — drives expand/collapse + the `data-section` attribute. */
    id: string;
    /** Visible header copy. Kept compact (one or two words). */
    label: string;
    /**
     * Optional count badge. Shown in the header right-aligned —
     * the orientation cue that says "this section has 3 values
     * to choose from".
     */
    count?: number;
    /**
     * The expanded content. The primitive doesn't constrain the
     * shape — consumers typically render a list of clickable
     * filter chips or links, but free-form JSX is allowed.
     */
    content: ReactNode;
}

export interface LeftAccordionRailProps {
    /** Optional rail-level title. When omitted no title row renders. */
    title?: string;
    sections: ReadonlyArray<LeftAccordionRailSection>;
    /** Default-open section ids. Empty by default (quiet state). */
    defaultOpenIds?: ReadonlyArray<string>;
    /** Outer-container class override. */
    className?: string;
    /** Aria-label for the rail nav landmark. */
    ariaLabel?: string;
    /** Stable id forwarded to the outer container (E2E selector). */
    id?: string;
    /**
     * PR-C — `localStorage` key under which the rail's
     * folded/expanded state persists across sessions. When omitted
     * the rail stays controlled-by-default-expanded and forgets the
     * fold state on remount. Setting a stable key per page (e.g.
     * `inflect:rail-folded:practices`) gives the user the "leave it
     * folded next time" experience.
     */
    persistKey?: string;
    /**
     * PR-C — whether the rail starts folded on first mount. Default
     * `false` so consumers get the existing behaviour unchanged.
     * Overridden by a persisted value when `persistKey` is set.
     */
    defaultFolded?: boolean;
}

// ─── Component ─────────────────────────────────────────────────────

export function LeftAccordionRail({
    title,
    sections,
    defaultOpenIds,
    className,
    ariaLabel: ariaLabelProp,
    id,
    persistKey,
    defaultFolded = false,
}: LeftAccordionRailProps) {
    const t = useTranslations('ui.leftAccordionRail');
    const ariaLabel = ariaLabelProp ?? t('tableOrientation');
    // Quiet-by-default — no sections open unless the consumer
    // explicitly seeds `defaultOpenIds`.
    const [openIds, setOpenIds] = useState<ReadonlySet<string>>(
        () => new Set(defaultOpenIds ?? []),
    );
    // PR-C — fold state. Initialised from the persisted value when
    // available; otherwise the consumer-supplied `defaultFolded`.
    // Reading localStorage in the initialiser is SSR-safe because
    // we guard on `window` existence.
    const [folded, setFolded] = useState<boolean>(() => {
        if (typeof window === 'undefined') return defaultFolded;
        if (!persistKey) return defaultFolded;
        try {
            const raw = window.localStorage.getItem(persistKey);
            if (raw === '1') return true;
            if (raw === '0') return false;
        } catch {
            // Storage may be disabled (private mode / quota); fall
            // back to the default. Never crash the render.
        }
        return defaultFolded;
    });
    // Persist whenever the fold state changes.
    useEffect(() => {
        if (typeof window === 'undefined' || !persistKey) return;
        try {
            window.localStorage.setItem(persistKey, folded ? '1' : '0');
        } catch {
            // No-op on storage failures.
        }
    }, [folded, persistKey]);
    const reactId = useId();

    const toggle = useCallback((sectionId: string) => {
        setOpenIds((prev) => {
            const next = new Set(prev);
            if (next.has(sectionId)) next.delete(sectionId);
            else next.add(sectionId);
            return next;
        });
    }, []);

    const handleKeyDown = (
        e: KeyboardEvent<HTMLButtonElement>,
        idx: number,
    ) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const nextIdx =
                e.key === 'ArrowDown'
                    ? (idx + 1) % sections.length
                    : (idx - 1 + sections.length) % sections.length;
            const nextBtn = document.querySelector<HTMLButtonElement>(
                `[data-rail-section-trigger="${sections[nextIdx].id}"]`,
            );
            nextBtn?.focus();
        }
    };

    // PR-C — collapsed surface. The rail folds down to a 28px-
    // wide spine carrying a single Expand button. The same
    // testids stay on the outer nav so E2E specs don't have to
    // know the fold state. ariaLabel widens with "(collapsed)"
    // so AT users hear the change.
    if (folded) {
        return (
            <nav
                id={id}
                data-testid={id ?? 'left-accordion-rail'}
                data-rail-folded="true"
                aria-label={t('collapsed', { label: ariaLabel })}
                className={cn(
                    cardVariants({ density: 'none' }),
                    'flex flex-col items-center self-start w-9 py-tight',
                    className,
                )}
            >
                <button
                    type="button"
                    data-testid="rail-fold-toggle"
                    aria-expanded="false"
                    aria-label={t('expandRail')}
                    onClick={() => setFolded(false)}
                    className={cn(
                        'flex h-7 w-7 items-center justify-center rounded-md',
                        'text-content-subtle transition-colors duration-100 ease-out',
                        'hover:bg-bg-muted/50 focus-visible:outline-none focus-visible:bg-bg-muted',
                    )}
                >
                    <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
            </nav>
        );
    }

    return (
        <nav
            id={id}
            data-testid={id ?? 'left-accordion-rail'}
            data-rail-folded="false"
            aria-label={ariaLabel}
            className={cn(
                // Sized for the docked column; the parent shell
                // owns column-width allocation. `w-60` (240px) at
                // xl+ is the canonical orientation-pane width;
                // mobile collapses to natural width because the
                // shell stacks the rail below the main column.
                cardVariants({ density: 'none' }),
                'xl:w-60 flex flex-col self-start',
                className,
            )}
        >
            {/* PR-C — header row with title + fold toggle. The
                toggle sits to the right; clicking it folds the
                rail to the 28px collapsed spine. Always rendered
                so the user can collapse even without a title. */}
            <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2 gap-tight">
                {title ? (
                    <span className="text-xs font-semibold uppercase tracking-widest text-content-subtle">
                        {title}
                    </span>
                ) : (
                    <span className="sr-only">{ariaLabel}</span>
                )}
                <button
                    type="button"
                    data-testid="rail-fold-toggle"
                    aria-expanded="true"
                    aria-label={t('collapseRail')}
                    onClick={() => setFolded(true)}
                    className={cn(
                        'flex h-6 w-6 items-center justify-center rounded-md',
                        '-mr-1 text-content-subtle transition-colors duration-100 ease-out',
                        'hover:bg-bg-muted/50 focus-visible:outline-none focus-visible:bg-bg-muted',
                    )}
                >
                    <ChevronLeft className="h-3 w-3" aria-hidden="true" />
                </button>
            </div>
            {/* Legacy title-only row was retired by the header
                row above (which carries both the title and the
                collapse button in one strip). Removed in
                #745-followup; CodeQL flagged the prior
                `false && ...` dead branch via
                `js/trivial-conditional`. */}
            <ul className="flex flex-col" role="list">
                {sections.map((section, idx) => {
                    const isOpen = openIds.has(section.id);
                    const triggerId = `${reactId}-trigger-${section.id}`;
                    const contentId = `${reactId}-content-${section.id}`;
                    return (
                        <li key={section.id} className="border-b border-border-subtle last:border-b-0">
                            <button
                                type="button"
                                id={triggerId}
                                data-rail-section-trigger={section.id}
                                aria-controls={contentId}
                                aria-expanded={isOpen}
                                onClick={() => toggle(section.id)}
                                onKeyDown={(e) => handleKeyDown(e, idx)}
                                className={cn(
                                    // Quiet, not loud. Subtle hover
                                    // muting + the chevron rotation
                                    // are the only motion the rail
                                    // commits to.
                                    'flex w-full items-center justify-between gap-tight px-3 py-2 text-left text-sm text-content-default',
                                    'transition-colors duration-100 ease-out',
                                    'hover:bg-bg-muted/50 focus-visible:outline-none focus-visible:bg-bg-muted',
                                )}
                            >
                                <span className="flex items-center gap-tight min-w-0">
                                    <ChevronRight
                                        className={cn(
                                            'h-3.5 w-3.5 flex-shrink-0 text-content-subtle transition-transform duration-150 ease-out',
                                            isOpen && 'rotate-90',
                                        )}
                                        aria-hidden="true"
                                    />
                                    <span className="truncate font-medium">{section.label}</span>
                                </span>
                                {typeof section.count === 'number' && (
                                    <span
                                        className="rounded-full bg-bg-subtle px-1.5 py-0.5 text-[10px] tabular-nums text-content-subtle"
                                        aria-hidden="true"
                                    >
                                        {section.count}
                                    </span>
                                )}
                            </button>
                            {isOpen && (
                                <div
                                    id={contentId}
                                    role="region"
                                    aria-labelledby={triggerId}
                                    data-rail-section-content={section.id}
                                    className="px-3 pb-3 pt-1"
                                >
                                    {section.content}
                                </div>
                            )}
                        </li>
                    );
                })}
            </ul>
        </nav>
    );
}
