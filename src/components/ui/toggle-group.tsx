"use client";

import { cn } from "@/lib/cn";
import { cva, type VariantProps } from "class-variance-authority";
import { LayoutGroup, motion } from "motion/react";
import Link from "next/link";
import {
    KeyboardEvent,
    ReactNode,
    useCallback,
    useId,
    useMemo,
    useRef,
} from "react";

/**
 * Epic 60 polish primitive — ToggleGroup.
 *
 * Segmented practice for a small set of mutually-exclusive choices
 * (time range: 7d/30d/90d/custom; view mode: list/grid/kanban; status
 * filter: all/open/closed). Sits in dense toolbars where a full
 * Combobox would be overkill and a Radio list would waste vertical
 * space.
 *
 * ## Variants
 *
 *   - `size: default` — 12px vertical padding, reads as a prominent
 *     practice on top of a card.
 *   - `size: sm` — compact 6px vertical padding for dense filter bars.
 *
 * ## Accessibility
 *
 * The group renders as `role="radiogroup"` with each option marked
 * `role="radio"` + `aria-checked`. Arrow keys cycle focus and
 * selection (APG automatic-activation), Home/End jump to endpoints.
 * Disabled options are skipped by the roving tabindex.
 *
 * Link-mode options render as `<Link>` — a Next.js navigation is what
 * commits the selection — and ARIA stays as `link`-like by dropping
 * the `role="radio"` in that case (they're navigation, not a radio).
 */

const toggleGroupVariants = cva(
    "border-border-subtle bg-bg-default relative z-0 inline-flex items-center rounded-lg border",
    {
        variants: {
            size: {
                default: "gap-1 p-1",
                sm: "gap-0.5 p-0.5",
            },
        },
        defaultVariants: { size: "default" },
    },
);

const toggleOptionVariants = cva(
    "text-content-emphasis relative z-10 flex items-center gap-tight font-medium capitalize outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-lg",
    {
        variants: {
            size: {
                default: "px-3 py-1 text-sm",
                sm: "px-2 py-0.5 text-xs",
            },
        },
        defaultVariants: { size: "default" },
    },
);

export interface ToggleGroupOption {
    value: string;
    label: string | ReactNode;
    badge?: ReactNode;
    href?: string;
    disabled?: boolean;
    /** Optional DOM id to pin on the rendered radio/link. Use for
     *  long-lived E2E selectors. Default: no id. */
    id?: string;
}

export interface ToggleGroupProps extends VariantProps<typeof toggleGroupVariants> {
    options: ToggleGroupOption[];
    selected: string | null;
    selectAction?: (option: string) => void;
    /** Defaults to `true` — motion layout animations on the pill. */
    layout?: boolean;
    className?: string;
    optionClassName?: string;
    indicatorClassName?: string;
    style?: React.CSSProperties;
    /** Screen-reader label for the radiogroup. Defaults to "Options". */
    ariaLabel?: string;
}

export function ToggleGroup({
    options,
    selected,
    selectAction,
    layout = true,
    size,
    className,
    optionClassName,
    indicatorClassName,
    style,
    ariaLabel = "Options",
}: ToggleGroupProps) {
    const layoutGroupId = useId();
    const btnRefs = useRef(new Map<string, HTMLElement>());

    const enabledNonLinkValues = useMemo(
        () =>
            options
                .filter((o) => !o.disabled && !o.href)
                .map((o) => o.value),
        [options],
    );

    const onKeyDown = useCallback(
        (e: KeyboardEvent<HTMLButtonElement>, value: string) => {
            if (enabledNonLinkValues.length === 0) return;
            const idx = enabledNonLinkValues.indexOf(value);
            if (idx === -1) return;

            let next: string | undefined;
            switch (e.key) {
                case "ArrowRight":
                case "ArrowDown":
                    next =
                        enabledNonLinkValues[
                            (idx + 1) % enabledNonLinkValues.length
                        ];
                    break;
                case "ArrowLeft":
                case "ArrowUp":
                    next =
                        enabledNonLinkValues[
                            (idx - 1 + enabledNonLinkValues.length) %
                                enabledNonLinkValues.length
                        ];
                    break;
                case "Home":
                    next = enabledNonLinkValues[0];
                    break;
                case "End":
                    next =
                        enabledNonLinkValues[
                            enabledNonLinkValues.length - 1
                        ];
                    break;
                default:
                    return;
            }
            e.preventDefault();
            const el = btnRefs.current.get(next);
            el?.focus();
            selectAction?.(next);
        },
        [enabledNonLinkValues, selectAction],
    );

    return (
        <LayoutGroup id={layoutGroupId}>
            <motion.div
                role="radiogroup"
                aria-label={ariaLabel}
                layout={layout}
                className={cn(toggleGroupVariants({ size }), className)}
                style={style}
            >
                {options.map((option) => {
                    const isSelected = option.value === selected;
                    const isDisabled = option.disabled === true;
                    const commonClassName = cn(
                        toggleOptionVariants({ size }),
                        !isSelected &&
                            !isDisabled &&
                            "hover:text-content-subtle z-[11] transition-colors",
                        isDisabled && "cursor-not-allowed opacity-50",
                        optionClassName,
                    );

                    const content = (
                        <>
                            {typeof option.label === "string" ? (
                                <p>{option.label}</p>
                            ) : (
                                option.label
                            )}
                            {option.badge}
                            {isSelected && (
                                <motion.div
                                    layoutId={layoutGroupId}
                                    className={cn(
                                        "border-border-subtle bg-bg-muted absolute left-0 top-0 -z-[1] h-full w-full rounded-lg border",
                                        indicatorClassName,
                                    )}
                                    transition={{ duration: 0.25 }}
                                />
                            )}
                        </>
                    );

                    if (option.href) {
                        return (
                            <Link
                                key={option.value}
                                id={option.id}
                                href={option.href}
                                data-selected={isSelected}
                                aria-current={
                                    isSelected ? "page" : undefined
                                }
                                aria-disabled={
                                    isDisabled ? true : undefined
                                }
                                className={commonClassName}
                                onClick={(e) => {
                                    if (isDisabled) {
                                        e.preventDefault();
                                        return;
                                    }
                                    selectAction?.(option.value);
                                }}
                            >
                                {content}
                            </Link>
                        );
                    }

                    return (
                        <button
                            key={option.value}
                            id={option.id}
                            ref={(el) => {
                                if (el)
                                    btnRefs.current.set(option.value, el);
                                else btnRefs.current.delete(option.value);
                            }}
                            type="button"
                            role="radio"
                            aria-checked={isSelected}
                            disabled={isDisabled}
                            tabIndex={
                                isDisabled ? -1 : isSelected ? 0 : -1
                            }
                            data-selected={isSelected}
                            className={commonClassName}
                            onClick={() => selectAction?.(option.value)}
                            onKeyDown={(e) => onKeyDown(e, option.value)}
                        >
                            {content}
                        </button>
                    );
                })}
            </motion.div>
        </LayoutGroup>
    );
}
