"use client";

/**
 * Epic 54 — canonical Sheet primitive.
 *
 * Persistent side panel for entity detail / inline-edit flows. Unlike
 * `<Modal>`, the Sheet keeps the list visible on desktop so users never
 * lose context when drilling into a row.
 *
 * Responsive posture:
 *   - Desktop: right-directional Vaul Drawer (side panel).
 *   - Mobile:  bottom-directional Vaul Drawer (matches Modal's mobile UX).
 *   Consumers opt out with `direction="right"` (always-right) for rare
 *   cases where the side panel must win on small screens too.
 *
 * Token alignment, accessible title fallback, and structured slots
 * (`Sheet.Header` / `Sheet.Body` / `Sheet.Footer` / `Sheet.Actions`) keep
 * every entity detail panel consistent with the Modal surface.
 *
 * Nesting: pass `nested` to mount Vaul `NestedRoot` when the sheet is
 * rendered inside another drawer (required by Vaul for focus-trap parity).
 */

import { cn } from "@/lib/cn";
import { useTranslations } from "next-intl";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import { ComponentProps, type HTMLAttributes, type ReactNode } from "react";
import { ContentProps, type DialogProps, Drawer } from "vaul";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { useKeyboardInset, useMediaQuery } from "./hooks";
import { OverlayDepthProvider } from "./overlay-depth";
import { ProgressiveBlur } from "./progressive-blur";
import { Tooltip } from "./tooltip";

// ─── Size variants (desktop width) ──────────────────────────────────

const sheetWidthVariants = cva("", {
    variants: {
        size: {
            sm: "[--sheet-width:420px]",
            md: "[--sheet-width:540px]",
            lg: "[--sheet-width:720px]",
            xl: "[--sheet-width:960px]",
        },
    },
    defaultVariants: { size: "md" },
});

// ─── Props ──────────────────────────────────────────────────────────

type SheetRootBaseProps = Omit<DialogProps, "direction" | "children"> & {
    children?: ReactNode;
    contentProps?: ContentProps;
    nested?: boolean;
    /**
     * `"responsive"` (default) — right on desktop, bottom on mobile, matching
     * Modal's mobile posture.
     * `"right"` — always right (rare; lose mobile ergonomics).
     * `"bottom"` — always bottom (special cases).
     */
    direction?: "responsive" | "right" | "bottom";
    /** Accessible name. Required for screen readers; visually-hidden fallback. */
    title?: string;
    /** Supplemental description wired to `aria-describedby`. */
    description?: string;
};

export type SheetRootProps = SheetRootBaseProps &
    VariantProps<typeof sheetWidthVariants>;

// ─── Component ──────────────────────────────────────────────────────

function SheetRoot({
    children,
    contentProps,
    nested = false,
    direction = "responsive",
    size,
    title,
    description,
    ...rest
}: SheetRootProps) {
    const t = useTranslations("ui.sheet");
    const { isMobile } = useMediaQuery();
    const { inset: keyboardInset, height: viewportHeight } = useKeyboardInset();
    const RootComponent = nested ? Drawer.NestedRoot : Drawer.Root;

    const effectiveDirection: "right" | "bottom" =
        direction === "responsive"
            ? isMobile
                ? "bottom"
                : "right"
            : direction;

    const isSide = effectiveDirection === "right";

    const fallbackTitle = (
        <VisuallyHidden.Root>
            <Drawer.Title>{title ?? t("sheetFallback")}</Drawer.Title>
            <Drawer.Description>{description ?? ""}</Drawer.Description>
        </VisuallyHidden.Root>
    );

    // Vaul's `DialogProps` is a discriminated union over snapPoints; TS
    // can't narrow the rest-spread through that, so we assert the composed
    // object as `DialogProps` — both Root and NestedRoot accept the same
    // runtime shape, and `SheetRootBaseProps extends Omit<DialogProps, …>`.
    const rootProps = {
        direction: effectiveDirection,
        handleOnly: true,
        ...rest,
    } as DialogProps;

    // Non-modal sheets (`modal={false}`) coexist with the page beneath them —
    // they neither inert the background (so the page's practices stay
    // operable + in the a11y tree) nor paint a blocking backdrop. Used by the
    // operator parcel sheet, which sits over the map while the map-mode
    // toolbar above it stays reachable. Default (undefined) keeps the modal
    // overlay exactly as before.
    const isModal = (rest as { modal?: boolean }).modal !== false;

    return (
        <RootComponent {...rootProps}>
            <Drawer.Portal>
                {isModal && (
                    <Drawer.Overlay
                        className="fixed inset-0 z-40 bg-bg-overlay backdrop-blur-sm"
                        data-sheet-overlay
                    />
                )}
                <Drawer.Content
                    {...contentProps}
                    onPointerDownOutside={(e) => {
                        if (
                            e.target instanceof Element &&
                            e.target.closest("[data-sonner-toast]")
                        )
                            e.preventDefault();
                        contentProps?.onPointerDownOutside?.(e);
                    }}
                    className={cn(
                        "@container/sheet fixed z-40 flex outline-none",
                        sheetWidthVariants({ size }),
                        isSide
                            ? [
                                  "bottom-2 right-2 top-2",
                                  "w-[min(var(--sheet-width),calc(100%-2*var(--sheet-margin)))] [--sheet-margin:8px]",
                              ]
                            : [
                                  "inset-x-2 bottom-2",
                                  "h-[min(var(--sheet-height),calc(100vh-var(--sheet-margin)*2))] [--sheet-margin:8px] [--sheet-height:85vh]",
                              ],
                        contentProps?.className,
                    )}
                    style={
                        {
                            "--initial-transform": "calc(100% + 8px)",
                            userSelect: "auto",
                            // Keyboard-aware (bottom drawer only): lift onto
                            // the keyboard's top edge + cap height to the
                            // visible viewport so a pinned footer stays
                            // reachable. The side panel is unaffected.
                            ...(!isSide && keyboardInset
                                ? {
                                      bottom: keyboardInset + 8,
                                      height: Math.max(0, viewportHeight - 16),
                                  }
                                : {}),
                            ...contentProps?.style,
                        } as React.CSSProperties
                    }
                    data-sheet-direction={effectiveDirection}
                >
                    <div
                        data-sheet-content
                        className={cn(
                            // B3 — brand-tinted focal-glow texture + elegant
                            // border + glass edge (see globals.css).
                            "surface-popup-texture flex size-full grow flex-col overflow-hidden rounded-lg text-content-emphasis",
                        )}
                    >
                        {fallbackTitle}
                        {!isSide ? <DrawerHandle /> : null}
                        <OverlayDepthProvider>{children}</OverlayDepthProvider>
                    </div>
                </Drawer.Content>
            </Drawer.Portal>
        </RootComponent>
    );
}

// Top drag-handle on the bottom-drawer variant (mobile).
function DrawerHandle() {
    return (
        <div className="sticky top-0 z-20 flex shrink-0 items-center justify-center rounded-t-[10px] bg-inherit">
            <div className="my-3 h-1 w-12 rounded-full bg-border-emphasis" />
        </div>
    );
}

// ─── Structured slots ───────────────────────────────────────────────

function Title({ className, ...rest }: ComponentProps<typeof Drawer.Title>) {
    return (
        <Drawer.Title
            className={cn(
                "text-lg font-semibold text-content-emphasis",
                className,
            )}
            {...rest}
        />
    );
}

function Description({
    className,
    ...rest
}: ComponentProps<typeof Drawer.Description>) {
    return (
        <Drawer.Description
            className={cn("text-sm text-content-muted", className)}
            {...rest}
        />
    );
}

function Header({
    title,
    description,
    className,
    children,
    showCloseButton = true,
    ...rest
}: HTMLAttributes<HTMLDivElement> & {
    title?: ReactNode;
    description?: ReactNode;
    /** Toggle the built-in close button. Default: true. */
    showCloseButton?: boolean;
}) {
    const tc = useTranslations("common");
    return (
        <div
            data-sheet-header
            className={cn(
                "flex shrink-0 items-start justify-between gap-compact border-b border-border-subtle px-5 py-4",
                className,
            )}
            {...rest}
        >
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                {title ? <Title>{title}</Title> : null}
                {description ? <Description>{description}</Description> : null}
                {children}
            </div>
            {showCloseButton ? (
                <Tooltip content={tc("close")} shortcut="Esc">
                    <Drawer.Close asChild>
                        <button
                            type="button"
                            aria-label={tc("close")}
                            data-sheet-close
                            className="shrink-0 rounded-md p-1.5 text-content-muted transition-colors hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            <X className="size-4" />
                        </button>
                    </Drawer.Close>
                </Tooltip>
            ) : null}
        </div>
    );
}

type ProgressiveBlurEdge = boolean | "top" | "bottom" | "both";

interface BodyProps extends HTMLAttributes<HTMLDivElement> {
    /**
     * Epic 64 — paint a `<ProgressiveBlur>` overlay at the body's
     * scroll edge so long content tapers off rather than abruptly
     * cutting at the footer. `true` shorthand = `"both"`.
     *
     * Off by default to keep every existing call site visually
     * unchanged. Opt in on long-form sheets (linked items panels,
     * scrollable forms) where the affordance materially helps.
     */
    progressiveBlur?: ProgressiveBlurEdge;
}

function Body({ className, progressiveBlur = false, children, ...rest }: BodyProps) {
    if (!progressiveBlur) {
        return (
            <div
                data-sheet-body
                className={cn(
                    "scrollbar-thin flex-1 overflow-y-auto px-5 py-4 text-sm text-content-default",
                    className,
                )}
                {...rest}
            >
                {children}
            </div>
        );
    }
    const edge = progressiveBlur === true ? "both" : progressiveBlur;
    return (
        <div
            data-sheet-body
            data-sheet-body-progressive-blur={edge}
            className={cn(
                "scrollbar-thin relative flex-1 overflow-y-auto px-5 py-4 text-sm text-content-default",
                className,
            )}
            {...rest}
        >
            {children}
            <ProgressiveBlur side={edge} size="3rem" />
        </div>
    );
}

function Footer({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            data-sheet-footer
            className={cn(
                "flex shrink-0 items-center justify-end gap-tight border-t border-border-subtle px-5 py-3",
                className,
            )}
            {...rest}
        />
    );
}

/**
 * Canonical Cancel | Save action row — mirrors `Modal.Actions` so detail
 * panels and modals share a single footer vocabulary.
 */
function Actions({
    className,
    children,
    align = "right",
    ...rest
}: HTMLAttributes<HTMLDivElement> & { align?: "left" | "right" | "between" }) {
    return (
        <Footer
            className={cn(
                align === "left" && "justify-start",
                align === "between" && "justify-between",
                className,
            )}
            {...rest}
        >
            {children}
        </Footer>
    );
}

function Close(props: ComponentProps<typeof Drawer.Close>) {
    return <Drawer.Close {...props} />;
}

export const Sheet = Object.assign(SheetRoot, {
    Title,
    Description,
    Header,
    Body,
    Footer,
    Actions,
    Close,
});
