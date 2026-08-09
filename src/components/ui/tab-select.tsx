"use client";

import { cn } from "@/lib/cn";
import { useTranslations } from "next-intl";
import { cva, type VariantProps } from "class-variance-authority";
import { LayoutGroup, motion } from "motion/react";
import Link from "next/link";
import {
    Dispatch,
    KeyboardEvent,
    ReactNode,
    SetStateAction,
    useCallback,
    useId,
    useMemo,
    useRef,
} from "react";
import { ArrowUpRight } from "./icons";

/**
 * Epic 60 polish primitive — TabSelect.
 *
 * Horizontal underline tab switcher for dashboards and settings nav.
 * Token-backed, keyboard-navigable (Arrow / Home / End with roving
 * tabindex), and wired for ARIA `tablist` semantics when used as
 * in-page navigation.
 *
 * ## When to use which variant
 *
 *   - `default` — subtle underline indicator that matches the rest of
 *     the neutral dashboard chrome. Use for in-page section nav.
 *   - `accent` — blue accent, higher emphasis. Use sparingly when the
 *     tab selection drives the whole page's content (e.g. "Overview /
 *     Findings / Evidence" at the top of a practice page).
 *
 * ## Links vs. callbacks
 *
 * If an option has `href`, the tab renders as a `<Link>` and no
 * `onSelect` is called — the route change drives selection via the
 * `selected` prop. If not, the tab fires `onSelect(id)` on click. Both
 * modes participate in the same roving-tabindex keyboard nav.
 *
 * ## Accessibility
 *
 * Container is `role="tablist"`, children are `role="tab"` with
 * `aria-selected` and a roving `tabIndex` (selected tab = 0, others =
 * -1). Arrow keys move focus AND selection (APG "automatic activation"
 * pattern) — consumers shouldn't need to press Enter to commit a
 * selection, because selection *is* navigation for this primitive.
 * Callers wiring the linked content should apply `role="tabpanel"` +
 * `aria-labelledby` themselves; the composite pattern is too varied
 * to bake in here.
 */

const tabSelectButtonVariants = cva(
    "p-4 transition-colors duration-75 outline-none rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    {
        variants: {
            variant: {
                default:
                    "text-content-subtle data-[selected=true]:text-content-emphasis data-[selected=false]:hover:text-content-default",
                accent:
                    "text-content-subtle transition-[color,font-weight] data-[selected=true]:text-content-info data-[selected=false]:hover:text-content-default data-[selected=true]:font-medium",
            },
        },
        defaultVariants: { variant: "default" },
    },
);

const tabSelectIndicatorVariants = cva("absolute bottom-0 w-full px-1.5", {
    variants: {
        variant: {
            default: "text-bg-inverted",
            accent: "text-content-info",
        },
    },
    defaultVariants: { variant: "default" },
});

export interface TabSelectOption<T extends string> {
    id: T;
    label: ReactNode;
    href?: string;
    target?: string;
    /** Render a badge chip to the right of the label. */
    badge?: ReactNode;
    /** Per-option disabled state. Disabled tabs skip the roving tabindex. */
    disabled?: boolean;
}

export interface TabSelectProps<T extends string>
    extends VariantProps<typeof tabSelectButtonVariants> {
    options: TabSelectOption<T>[];
    selected: string | null;
    onSelect?: Dispatch<SetStateAction<T>> | ((id: T) => void);
    className?: string;
    /** Screen-reader label for the tablist. Defaults to "Tabs". */
    ariaLabel?: string;
    /**
     * Prefix for each tab's DOM `id`. The rendered id is
     * `${idPrefix}${option.id}`. Default uses a `useId()`-namespaced
     * prefix so two TabSelects on the same page don't collide. Pass
     * `"tab-"` (or similar) when stable, selector-friendly ids matter
     * — e.g. for long-lived E2E selectors.
     */
    idPrefix?: string;
}

export function TabSelect<T extends string>({
    variant,
    options,
    selected,
    onSelect,
    className,
    ariaLabel: ariaLabelProp,
    idPrefix,
}: TabSelectProps<T>) {
    const t = useTranslations("ui.tabSelect");
    const ariaLabel = ariaLabelProp ?? t("tabs");
    const layoutGroupId = useId();
    const effectiveIdPrefix = idPrefix ?? `tab-${layoutGroupId}-`;
    const btnRefs = useRef(new Map<string, HTMLElement>());

    const enabledIds = useMemo(
        () => options.filter((o) => !o.disabled).map((o) => o.id),
        [options],
    );

    const focusById = useCallback((id: string) => {
        btnRefs.current.get(id)?.focus();
    }, []);

    const onKeyDown = useCallback(
        (e: KeyboardEvent<HTMLElement>, id: T) => {
            if (enabledIds.length === 0) return;
            const idx = enabledIds.indexOf(id);
            if (idx === -1) return;

            let next: T | undefined;
            switch (e.key) {
                case "ArrowRight":
                    next = enabledIds[(idx + 1) % enabledIds.length] as T;
                    break;
                case "ArrowLeft":
                    next = enabledIds[
                        (idx - 1 + enabledIds.length) % enabledIds.length
                    ] as T;
                    break;
                case "Home":
                    next = enabledIds[0] as T;
                    break;
                case "End":
                    next = enabledIds[enabledIds.length - 1] as T;
                    break;
                default:
                    return;
            }
            e.preventDefault();
            focusById(next);
            // Automatic activation (APG): moving focus activates the tab.
            // Callers that need deferred activation can pass `onSelect`
            // that gates on a separate commit (rare — not worth an API
            // surface until someone needs it).
            onSelect?.(next);
        },
        [enabledIds, focusById, onSelect],
    );

    return (
        <div
            role="tablist"
            aria-label={ariaLabel}
            aria-orientation="horizontal"
            className={cn("flex text-sm", className)}
        >
            <LayoutGroup id={layoutGroupId}>
                {options.map(({ id, label, href, target, badge, disabled }) => {
                    const isSelected = id === selected;
                    const As = href ? Link : "div";
                    return (
                        <As
                            key={id}
                            className="relative"
                            href={href ?? "#"}
                            target={target ?? undefined}
                        >
                            <button
                                type="button"
                                ref={(el) => {
                                    if (el) btnRefs.current.set(id, el);
                                    else btnRefs.current.delete(id);
                                }}
                                role="tab"
                                id={`${effectiveIdPrefix}${id}`}
                                aria-selected={isSelected}
                                tabIndex={
                                    disabled ? -1 : isSelected ? 0 : -1
                                }
                                disabled={disabled}
                                onKeyDown={(e) => onKeyDown(e, id)}
                                {...(onSelect && !href && {
                                    onClick: () => onSelect(id),
                                })}
                                className={cn(
                                    tabSelectButtonVariants({ variant }),
                                    target === "_blank" &&
                                        "group flex items-center gap-1.5",
                                    disabled &&
                                        "cursor-not-allowed opacity-50",
                                )}
                                data-selected={isSelected}
                            >
                                {label}
                                {badge}
                                {target === "_blank" && (
                                    <ArrowUpRight
                                        aria-hidden
                                        className="size-2.5"
                                    />
                                )}
                            </button>
                            {isSelected && (
                                <motion.div
                                    layoutId="indicator"
                                    transition={{ duration: 0.1 }}
                                    className={tabSelectIndicatorVariants({
                                        variant,
                                    })}
                                >
                                    <div className="h-0.5 rounded-t-full bg-current" />
                                </motion.div>
                            )}
                        </As>
                    );
                })}
            </LayoutGroup>
        </div>
    );
}
