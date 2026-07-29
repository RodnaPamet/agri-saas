"use client";

/**
 * Rich Tooltip primitive (Epic 56).
 *
 * A single canonical tooltip for the whole app. Built on Radix Tooltip so we
 * get focus/keyboard/Escape behavior and Portal rendering for free.
 *
 * Use it instead of the native `title=` attribute for any help affordance,
 * disabled-state explanation, icon-button label, or short status hint.
 *
 *   <Tooltip content="Delete row">
 *     <button aria-label="Delete"><TrashIcon /></button>
 *   </Tooltip>
 *
 *   <Tooltip
 *     title="ISO 27001 — Clause 9.3"
 *     content="Management review ensures the ISMS remains suitable."
 *     shortcut="?"
 *   >
 *     <Button variant="ghost" icon={<HelpIcon />} />
 *   </Tooltip>
 *
 *   <InfoTooltip content="Evidence must be dated." />
 *
 * Use a Popover, not a Tooltip, when the content is interactive (links,
 * buttons, form controls) or must stay open while the user reads it —
 * tooltips disappear on blur/Escape and are announced as `role="tooltip"`.
 */

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { HelpCircle } from "lucide-react";
import {
    forwardRef,
    useCallback,
    useEffect,
    useRef,
    useState,
    useSyncExternalStore,
    type ReactNode,
} from "react";
import { cn } from "@/lib/cn";

export type TooltipSide = "top" | "right" | "bottom" | "left";
export type TooltipAlign = "start" | "center" | "end";

/**
 * Global kill-switch (temporary). Hover/focus tooltips misbehave on
 * touch devices — the Radix popup opens on the synthesised focus of a
 * tap and then sits over the UI, intercepting the next touch. Until a
 * touch-aware fix lands we disable tooltips app-wide: `<Tooltip>` (and
 * therefore `<InfoTooltip>` / `<DynamicTooltipWrapper>`, which delegate
 * to it) renders its trigger child with no popup wiring. Flip this back
 * to `true` to restore tooltips everywhere — no call-site changes needed.
 * Exported so the behavioural tooltip tests skip themselves while the
 * popup is switched off (they auto-restore when this flips back).
 */
export const TOOLTIPS_ENABLED = true;

/**
 * How long a tapped-open tooltip stays up before dismissing itself.
 * Long enough to read a sentence one-handed, short enough that a
 * forgotten tooltip never sits over the UI.
 */
const TOUCH_AUTO_DISMISS_MS = 6000;

/**
 * True on devices whose primary pointer cannot hover — phones, tablets.
 *
 * Subscribed rather than read once: tablets with a detachable keyboard or
 * a paired mouse flip this at runtime, and a stale value would leave the
 * user with the wrong open gesture until remount.
 *
 * `useSyncExternalStore` gives an SSR-safe answer (false on the server, so
 * markup matches the desktop-first render) with no effect-driven flash.
 */
function useCoarsePointer(): boolean {
    const subscribe = useCallback((onChange: () => void) => {
        if (typeof window === "undefined" || !window.matchMedia) return () => {};
        const mq = window.matchMedia("(hover: none), (pointer: coarse)");
        // Safari < 14 only has the deprecated listener API.
        if (mq.addEventListener) {
            mq.addEventListener("change", onChange);
            return () => mq.removeEventListener("change", onChange);
        }
        mq.addListener(onChange);
        return () => mq.removeListener(onChange);
    }, []);

    return useSyncExternalStore(
        subscribe,
        () =>
            typeof window !== "undefined" &&
            typeof window.matchMedia === "function" &&
            window.matchMedia("(hover: none), (pointer: coarse)").matches,
        () => false,
    );
}

/**
 * Global provider. Mount once at the app root so Radix can share the
 * delay timer across tooltips — once one is open, subsequent tooltips
 * open instantly until the user pauses.
 */
export function TooltipProvider({
    children,
    delayDuration = 1000,
    skipDelayDuration = 300,
}: {
    children: ReactNode;
    delayDuration?: number;
    skipDelayDuration?: number;
}) {
    return (
        <TooltipPrimitive.Provider
            delayDuration={delayDuration}
            skipDelayDuration={skipDelayDuration}
        >
            {children}
        </TooltipPrimitive.Provider>
    );
}

export interface TooltipProps {
    /** Element that triggers the tooltip. Must accept a ref (Radix uses asChild). */
    children: ReactNode;
    /**
     * Primary content. String renders as plain text. ReactNode lets callers
     * compose headings, kbd, lists, status badges, etc.
     */
    content: ReactNode;
    /** Optional bold heading rendered above `content`. */
    title?: ReactNode;
    /** Optional keyboard shortcut badge rendered on the right of the heading row. */
    shortcut?: string;
    /** Short-circuit: render children with no tooltip wiring. */
    disabled?: boolean;
    side?: TooltipSide;
    align?: TooltipAlign;
    sideOffset?: number;
    /** Override the provider's delay for this tooltip only. */
    delayDuration?: number;
    /** Pass through to hide the tooltip when the pointer leaves its content. */
    disableHoverableContent?: boolean;
    /** Escape hatch for callers that need to style the content surface. */
    contentClassName?: string;
}

/**
 * Canonical tooltip. Wrap any focusable/hoverable element.
 *
 * Content supports a short string or composed ReactNode; use `title` for the
 * heading + body pattern instead of building markup every time.
 *
 * Wrapped in `forwardRef` so a parent that uses `asChild` (Popover.Trigger,
 * Dialog.Trigger, Radix Slot) can compose its ref with the underlying
 * trigger element. Without this, `<Popover><Tooltip>...</Tooltip></Popover>`
 * triggers React's "function components cannot be given refs" warning.
 */
export const Tooltip = forwardRef<HTMLButtonElement, TooltipProps>(function Tooltip(
    {
        children,
        content,
        title,
        shortcut,
        disabled,
        side = "top",
        align = "center",
        sideOffset = 6,
        delayDuration,
        disableHoverableContent,
        contentClassName,
    },
    ref,
) {
    // ── Touch support ────────────────────────────────────────────────
    //
    // Radix deliberately gives touch users nothing: its Trigger early-returns
    // from `onPointerMove` when `pointerType === "touch"`, and separately
    // wires `onPointerDown` and `onClick` to CLOSE. Together with the
    // `:focus-visible` gate below (a tap produces no `:focus-visible`), that
    // leaves a phone with no way to ever see a tooltip — which on a
    // mobile-first product means help icons that are pure decoration.
    //
    // So on coarse pointers we drive `open` ourselves: tap toggles, and the
    // tap handler calls `preventDefault()` so Radix's own composed
    // close-handlers are skipped. That is the same `composeEventHandlers`
    // trick the focus guard below relies on. Pointer devices are left
    // entirely on Radix's hover behaviour — same primitive, same content,
    // same appearance; only the gesture that opens it differs, because a
    // phone has no hover to offer.
    const coarsePointer = useCoarsePointer();
    const [touchOpen, setTouchOpen] = useState(false);
    const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const triggerNode = useRef<HTMLElement | null>(null);

    const closeTouch = useCallback(() => {
        setTouchOpen(false);
        if (dismissTimer.current) {
            clearTimeout(dismissTimer.current);
            dismissTimer.current = null;
        }
    }, []);

    // Dismiss on the next touch anywhere, on scroll, and on a timeout. Any
    // one of these alone leaves a way for the popup to sit over the UI.
    useEffect(() => {
        if (!touchOpen) return;
        const onOutside = (e: Event) => {
            const el = e.target as Node | null;
            if (el && triggerNode.current?.contains(el)) return;
            closeTouch();
        };
        document.addEventListener("pointerdown", onOutside, true);
        window.addEventListener("scroll", closeTouch, true);
        dismissTimer.current = setTimeout(closeTouch, TOUCH_AUTO_DISMISS_MS);
        return () => {
            document.removeEventListener("pointerdown", onOutside, true);
            window.removeEventListener("scroll", closeTouch, true);
            if (dismissTimer.current) clearTimeout(dismissTimer.current);
        };
    }, [touchOpen, closeTouch]);

    if (!TOOLTIPS_ENABLED || disabled || (content == null && title == null)) {
        return <>{children}</>;
    }

    return (
        <TooltipPrimitive.Root
            delayDuration={delayDuration}
            disableHoverableContent={disableHoverableContent}
            {...(coarsePointer
                ? { open: touchOpen, onOpenChange: setTouchOpen }
                : {})}
        >
            <TooltipPrimitive.Trigger
                ref={(node: HTMLButtonElement | null) => {
                    triggerNode.current = node;
                    if (typeof ref === "function") ref(node);
                    else if (ref) ref.current = node;
                }}
                asChild
                // Touch: tap toggles. `preventDefault()` is load-bearing —
                // Radix composes its own `onPointerDown`/`onClick` CLOSE
                // handlers after ours, and skips them when the event is
                // default-prevented. Without it the tooltip would open and
                // immediately close on the same tap.
                onPointerDown={
                    coarsePointer
                        ? (e) => {
                              e.preventDefault();
                              setTouchOpen((v) => !v);
                          }
                        : undefined
                }
                onClick={coarsePointer ? (e) => e.preventDefault() : undefined}
                // Hover-or-keyboard, never auto. Radix opens the tooltip on
                // ANY focus, so when a popover/dialog auto-focuses its first
                // control (e.g. the calendar's prev-month arrow, or the theme
                // toggle on a freshly-opened menu) the tooltip pops without
                // the user hovering. We gate Radix's focus-open on
                // `:focus-visible`: keyboard focus still opens it (the a11y
                // affordance), but programmatic / pointer focus does not.
                // React's SyntheticEvent.preventDefault() sets
                // `defaultPrevented` unconditionally, and Radix wires this via
                // `composeEventHandlers(props.onFocus, openOnFocus)` which
                // skips its handler when the event is default-prevented.
                onFocus={(e) => {
                    try {
                        if (!e.currentTarget.matches(":focus-visible")) {
                            e.preventDefault();
                        }
                    } catch {
                        // `:focus-visible` unsupported (e.g. jsdom) — leave the
                        // default keyboard-a11y behaviour intact.
                    }
                }}
            >
                {children}
            </TooltipPrimitive.Trigger>
            <TooltipPrimitive.Portal>
                <TooltipPrimitive.Content
                    side={side}
                    align={align}
                    sideOffset={sideOffset}
                    collisionPadding={8}
                    className={cn(
                        // Layering: tooltips must always float above modals,
                        // sheets and popovers (which top out at z-50).
                        "z-[99] pointer-events-auto",
                        // Surface (token-backed)
                        "rounded-lg border border-border-default bg-bg-elevated shadow-lg",
                        "max-w-xs px-3 py-2",
                        "text-xs leading-snug text-content-default",
                        // Motion — keyed to Radix's side data attributes so
                        // the animation direction matches the tooltip position.
                        "animate-slide-up-fade",
                        "data-[side=bottom]:animate-slide-down-fade",
                        "data-[state=closed]:opacity-0",
                        contentClassName,
                    )}
                >
                    <TooltipBody title={title} shortcut={shortcut}>
                        {content}
                    </TooltipBody>
                </TooltipPrimitive.Content>
            </TooltipPrimitive.Portal>
        </TooltipPrimitive.Root>
    );
});

function TooltipBody({
    title,
    shortcut,
    children,
}: {
    title?: ReactNode;
    shortcut?: string;
    children: ReactNode;
}) {
    const hasHeader = title != null || shortcut != null;
    return (
        <div className="flex flex-col gap-1">
            {hasHeader && (
                <div className="flex items-center justify-between gap-compact">
                    {title != null && (
                        <span className="text-[13px] font-semibold text-content-emphasis">
                            {title}
                        </span>
                    )}
                    {shortcut && (
                        <kbd className="ml-auto rounded border border-border-subtle bg-bg-subtle px-1.5 py-0.5 text-[10px] font-medium text-content-muted">
                            {shortcut}
                        </kbd>
                    )}
                </div>
            )}
            {children != null && (
                <div
                    className={cn(
                        hasHeader ? "text-content-muted" : "text-content-default",
                    )}
                >
                    {children}
                </div>
            )}
        </div>
    );
}

/**
 * Standalone inline help icon. Use next to form labels, status pills, or
 * any place where you need a short explanatory hint without an interactive
 * trigger of its own.
 */
export const InfoTooltip = forwardRef<
    HTMLButtonElement,
    Omit<TooltipProps, "children"> & {
        iconClassName?: string;
        /** Accessible label for the help icon button. Defaults to "More information". */
        "aria-label"?: string;
    }
>(function InfoTooltip(
    { iconClassName, "aria-label": ariaLabel = "More information", ...tooltipProps },
    ref,
) {
    return (
        <Tooltip {...tooltipProps}>
            <button
                ref={ref}
                type="button"
                aria-label={ariaLabel}
                className="inline-flex h-4 w-4 items-center justify-center rounded-full text-content-muted outline-none transition-colors hover:text-content-default focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
                <HelpCircle className={cn("h-4 w-4", iconClassName)} aria-hidden="true" />
            </button>
        </Tooltip>
    );
});

/**
 * Optional wrap helper for callers that conditionally want a tooltip (e.g.,
 * a status badge that only explains itself when context data exists).
 *
 *   <DynamicTooltipWrapper tooltipProps={value ? { content: describe(value) } : undefined}>
 *     <StatusBadge ... />
 *   </DynamicTooltipWrapper>
 */
export const DynamicTooltipWrapper = forwardRef<
    HTMLButtonElement,
    {
        children: ReactNode;
        tooltipProps?: Omit<TooltipProps, "children">;
    }
>(function DynamicTooltipWrapper({ children, tooltipProps }, ref) {
    if (!tooltipProps) return <>{children}</>;
    return (
        <Tooltip ref={ref} {...tooltipProps}>
            {children}
        </Tooltip>
    );
});
