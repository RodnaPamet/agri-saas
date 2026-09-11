"use client";

/**
 * Epic 54 — canonical Popover primitive.
 *
 * Radix Popover on desktop, Vaul Drawer on mobile (via `useMediaQuery`).
 * Powers every contextual surface in the app — filter dropdowns, column
 * toggles, future row-action menus — so all lightweight surfaces share
 * one keyboard model, one Escape behaviour, and one token palette.
 *
 * Composite API:
 *   - `<Popover content={…}>{trigger}</Popover>` — the canonical controlled
 *     form, used by 30+ filter/menu sites today.
 *   - `<Popover.Menu>` + `<Popover.Item>` — slot primitives for consistent
 *     action-menu layout (label, icon, shortcut, disabled, destructive).
 *     Use these inside `content` to keep every menu identical.
 */

import { cn } from "@/lib/cn";
import { useTranslations } from "next-intl";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import {
  ButtonHTMLAttributes,
  HTMLAttributes,
  PropsWithChildren,
  ReactNode,
  WheelEventHandler,
  forwardRef,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { Drawer } from "vaul";
import { useKeyboardInset, useMediaQuery, useReducedMotion } from "./hooks";
import { OverlayDepthProvider, useOverlayDepth } from "./overlay-depth";
import { Tooltip } from "./tooltip";

export type PopoverProps = PropsWithChildren<{
  content: ReactNode | string;
  align?: "center" | "start" | "end";
  side?: "bottom" | "top" | "left" | "right";
  openPopover: boolean;
  setOpenPopover: (open: boolean) => void;
  mobileOnly?: boolean;
  /**
   * Explicit always-dropdown override — renders the portalled desktop-style
   * popover even on mobile. Reserved for on-page pickers where a bottom
   * sheet would cover essential context (e.g. a map prescription picker).
   *
   * P3.2: nesting no longer needs this. A popover already inside a
   * Modal/Sheet/Popover is detected via `OverlayDepthContext` and
   * auto-renders as a dropdown. The two signals are OR'd, so passing
   * `forceDropdown` inside an overlay is redundant (harmless).
   */
  forceDropdown?: boolean;
  popoverContentClassName?: string;
  onOpenAutoFocus?: PopoverPrimitive.PopoverContentProps["onOpenAutoFocus"];
  onCloseAutoFocus?: PopoverPrimitive.PopoverContentProps["onCloseAutoFocus"];
  collisionBoundary?: Element | Element[];
  sticky?: "partial" | "always";
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onWheel?: WheelEventHandler;
  sideOffset?: number;
  anchor?: ReactNode;
  /**
   * Canonical hover hint for the trigger. When set, the trigger child is wrapped
   * in `<Tooltip>` INSIDE the asChild Trigger so the popover-open click and the
   * tooltip hover both land on the same element (Radix Slot merges them). Use
   * this instead of a native `title=` on a popover trigger.
   */
  triggerTooltip?: string;
}>;

function PopoverRoot({
  children,
  content,
  align = "center",
  side = "bottom",
  openPopover,
  setOpenPopover,
  mobileOnly,
  forceDropdown,
  popoverContentClassName,
  onOpenAutoFocus,
  onCloseAutoFocus,
  collisionBoundary,
  sticky,
  onEscapeKeyDown,
  onWheel,
  sideOffset = 8,
  anchor,
  triggerTooltip,
}: PopoverProps) {
  const t = useTranslations("ui.popover");
  const { isMobile } = useMediaQuery();
  const { inset: keyboardInset, height: viewportHeight } = useKeyboardInset();
  const reducedMotion = useReducedMotion();
  // P3.2 — a popover already inside an overlay (Modal / Sheet / another
  // Popover) renders as a portalled dropdown instead of stacking a second
  // Vaul bottom-sheet, even on mobile. The explicit `forceDropdown` override
  // is OR'd in for on-page always-dropdown pickers.
  const overlayDepth = useOverlayDepth();
  const renderAsDropdown = forceDropdown || overlayDepth > 0;
  // P3.2-follow — a popover nested inside an overlay can't stack a second Vaul
  // drawer (above), so it falls through to the Radix dropdown. But on a phone a
  // TRIGGER-ANCHORED dropdown inside a bottom Sheet lands cramped and clipped
  // near the top of the screen. Bottom-anchor it instead so every mobile picker
  // reads the same way — the drawer above and this one both rise from the
  // bottom edge. `forceDropdown` callers opted into a dropdown explicitly, so
  // they keep trigger anchoring. Re-anchoring happens in TWO places, both
  // keyed off the `data-mobile-sheet` marker below: a globals.css rule (the
  // no-flash fast path) and the JS pin further down (the actual guarantee —
  // see why the CSS alone isn't enough).
  const mobileSheetInOverlay = isMobile && !forceDropdown && overlayDepth > 0;

  // Radix positions the content through a WRAPPER element it owns and writes
  // inline styles onto (`position/left/top/transform/min-width`). No React
  // className can reach that node, and the globals.css `:has()` rule that
  // targets it is unreliable in the field: **Safari does not reliably
  // re-evaluate `:has()` when the matching child is inserted dynamically**,
  // which is exactly what happens when a popover opens — so on iOS the panel
  // stayed anchored to its trigger while the content-level classes applied.
  //
  // Pin the wrapper from JS instead. Radix rewrites those inline styles on
  // every reposition, so a MutationObserver re-applies ours; the guard makes
  // the write idempotent so observing our own mutation can't loop.
  const pinWrapperToBottom = useCallback((wrapper: HTMLElement) => {
    if (wrapper.style.getPropertyValue("transform") === "none") return; // already pinned
    wrapper.style.setProperty("position", "fixed", "important");
    wrapper.style.setProperty("inset", "auto 0 0 0", "important");
    wrapper.style.setProperty("transform", "none", "important");
    wrapper.style.setProperty("min-width", "0", "important");
    wrapper.style.setProperty("max-width", "100vw", "important");
  }, []);

  // A CALLBACK ref, not a ref object + effect: Radix mounts the content through
  // a portal/Presence, so the node isn't attached yet when a mount effect runs
  // (the ref reads null and the pin silently never happens). A callback ref
  // fires exactly when the node lands.
  const observerRef = useRef<MutationObserver | null>(null);
  const attachContent = useCallback(
    (node: HTMLDivElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!node || !mobileSheetInOverlay) return;
      // Walk up rather than assuming parentElement — Radix may nest the content
      // below the positioned wrapper.
      let wrapper: HTMLElement | null = node.parentElement;
      while (wrapper && !wrapper.hasAttribute("data-radix-popper-content-wrapper")) {
        wrapper = wrapper.parentElement;
      }
      if (!wrapper) return;
      const target = wrapper;
      pinWrapperToBottom(target);
      const observer = new MutationObserver(() => pinWrapperToBottom(target));
      observer.observe(target, { attributes: true, attributeFilter: ["style"] });
      observerRef.current = observer;
    },
    [mobileSheetInOverlay, pinWrapperToBottom],
  );

  useEffect(() => () => observerRef.current?.disconnect(), []);
  // When a trigger tooltip is requested, wrap the whole Radix Trigger ELEMENT
  // (not the inner button) in <Tooltip>. Order matters: Tooltip OUTER →
  // Popover.Trigger INNER → button. The inner Popover.Trigger's asChild Slot
  // owns the open-onClick on the button, and the outer Tooltip's hover props
  // merge through it — so the popover still opens. The reverse nesting (Tooltip
  // inside the Trigger) swallowed the click: the old "gear doesn't open" bug.
  const withTooltip = (el: ReactNode) =>
    triggerTooltip ? <Tooltip content={triggerTooltip}>{el}</Tooltip> : el;

  if (!renderAsDropdown && (mobileOnly || isMobile)) {
    return (
      <Drawer.Root open={openPopover} onOpenChange={setOpenPopover}>
        {withTooltip(
          <Drawer.Trigger className="sm:hidden" asChild>
            {children}
          </Drawer.Trigger>,
        )}
        <Drawer.Portal>
          <Drawer.Overlay className="bg-bg-subtle fixed inset-0 z-50 bg-opacity-10 backdrop-blur" />
          <Drawer.Content
            className="surface-popup-texture fixed bottom-0 left-0 right-0 z-50 mt-24 rounded-t-[10px]"
            // P3.1 — keyboard-avoidance. When a focused input inside the
            // sheet (a Combobox search field, a form field) raises the soft
            // keyboard, the visual viewport shrinks from the bottom and would
            // hide the sheet's lower half behind the keyboard. Lift the sheet
            // onto the keyboard's top edge (`bottom`) and cap its height to
            // the visible viewport so the focused input stays on-screen. The
            // transition is suppressed under prefers-reduced-motion.
            style={
              keyboardInset
                ? {
                    bottom: keyboardInset,
                    maxHeight: viewportHeight,
                    transition: reducedMotion
                      ? undefined
                      : "bottom 150ms ease-out, max-height 150ms ease-out",
                  }
                : undefined
            }
            onEscapeKeyDown={onEscapeKeyDown}
            onPointerDownOutside={(e) => {
              // Prevent dismissal when clicking inside a toast
              if (
                e.target instanceof Element &&
                e.target.closest("[data-sonner-toast]")
              ) {
                e.preventDefault();
              }
            }}
          >
            {/* Vaul's Drawer wraps Radix Dialog under the hood, which
                requires a Title + Description for screen readers.
                Popover contents are diverse (filter menus, date pickers,
                action lists) so we ship a visually-hidden default pair
                — content-specific titles still win via Drawer.Title
                inside the `content` slot. */}
            <VisuallyHidden.Root>
              <Drawer.Title>{t("menu")}</Drawer.Title>
              <Drawer.Description>{t("content")}</Drawer.Description>
            </VisuallyHidden.Root>
            <div className="sticky top-0 z-20 flex w-full items-center justify-center rounded-t-[10px] bg-inherit">
              <div className="bg-border-default my-3 h-1 w-12 rounded-full" />
            </div>
            <div className="bg-bg-default flex w-full items-center justify-center overflow-hidden pb-4 align-middle shadow-xl">
              <OverlayDepthProvider>{content}</OverlayDepthProvider>
            </div>
          </Drawer.Content>
          <Drawer.Overlay />
        </Drawer.Portal>
      </Drawer.Root>
    );
  }

  return (
    <PopoverPrimitive.Root open={openPopover} onOpenChange={setOpenPopover}>
      {anchor &&
        typeof document !== "undefined" &&
        createPortal(
          <PopoverPrimitive.Anchor asChild>{anchor}</PopoverPrimitive.Anchor>,
          document.body,
        )}
      {withTooltip(
        <PopoverPrimitive.Trigger className="sm:inline-flex" asChild>
          {children}
        </PopoverPrimitive.Trigger>,
      )}
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          ref={attachContent}
          sideOffset={mobileSheetInOverlay ? 0 : sideOffset}
          align={align}
          side={side}
          data-mobile-sheet={mobileSheetInOverlay ? "true" : undefined}
          className={cn(
            // B3-follow (2026-06-08): popover surfaces (user menu,
            // notifications, tenant/org switchers, comboboxes) share the
            // same brand-tinted focal-glow texture as modals/sheets/toast
            // — `.surface-popup-texture` owns background + border + the
            // glass-edge/drop-shadow, so no flat bg-bg-default/border here.
            "surface-popup-texture animate-slide-up-fade z-50 items-center rounded-lg sm:block",
            // Bottom-sheet skin for the in-overlay mobile case: square off the
            // bottom corners against the screen edge and cap the height so a
            // long option list scrolls inside the sheet instead of running off.
            mobileSheetInOverlay &&
              "w-full max-w-none rounded-b-none rounded-t-[10px] max-h-[70svh] overflow-y-auto",
            popoverContentClassName,
          )}
          // Keyboard-avoidance, mirroring the Vaul branch above: lift the sheet
          // onto the soft keyboard's top edge so a focused search input inside
          // it stays visible. The wrapper is pinned to the viewport bottom, so
          // the lift is expressed as a bottom margin on the content itself.
          style={
            mobileSheetInOverlay && viewportHeight
              ? {
                  // Cap to the measured visual viewport whenever it is known;
                  // lift only when a keyboard is actually open. Gating BOTH on
                  // `keyboardInset` meant the cap vanished together with the
                  // lift, falling back to a class-level viewport unit.
                  maxHeight: viewportHeight,
                  ...(keyboardInset ? { marginBottom: keyboardInset } : {}),
                  transition: reducedMotion
                    ? undefined
                    : "margin-bottom 150ms ease-out, max-height 150ms ease-out",
                }
              : undefined
          }
          sticky={sticky}
          collisionBoundary={collisionBoundary}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
          onEscapeKeyDown={onEscapeKeyDown}
          onWheel={onWheel}
        >
          <OverlayDepthProvider>{content}</OverlayDepthProvider>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

// ─── Menu / Item slots ─────────────────────────────────────────────

/**
 * Standard menu container. Drop inside a Popover's `content` prop to
 * keep every action menu aligned on padding, width, and keyboard feel.
 */
function Menu({
    className,
    children,
    ...rest
}: HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            role="menu"
            data-popover-menu
            className={cn(
                "flex min-w-[180px] flex-col gap-0.5 p-1 text-sm",
                className,
            )}
            {...rest}
        >
            {children}
        </div>
    );
}

export interface PopoverItemProps
    extends ButtonHTMLAttributes<HTMLButtonElement> {
    /** Leading icon slot. */
    icon?: ReactNode;
    /** Trailing element (shortcut hint, badge, chevron). */
    right?: ReactNode;
    /** Destructive / danger styling — use for delete/revoke actions. */
    destructive?: boolean;
    /** Currently selected / active state (checkmark-style menus). */
    selected?: boolean;
}

/**
 * Single action row inside a menu. Token-driven, keyboard-focusable,
 * supports destructive + selected variants. Consumers supply `onClick`
 * (or `onSelect`-style handlers) and the label as children.
 */
const Item = forwardRef<HTMLButtonElement, PopoverItemProps>(function Item(
    {
        className,
        children,
        icon,
        right,
        destructive = false,
        selected = false,
        disabled,
        type = "button",
        ...rest
    },
    ref,
) {
    return (
        <button
            ref={ref}
            type={type}
            role="menuitem"
            data-popover-item
            data-destructive={destructive || undefined}
            data-selected={selected || undefined}
            disabled={disabled}
            className={cn(
                // ≥44px tap target on mobile (bottom-sheet menus); desktop
                // popovers reset to the compact height via `sm:min-h-0`.
                "flex w-full min-h-[44px] cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left sm:min-h-0",
                "transition-colors duration-100 ease-out motion-reduce:transition-none",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:cursor-not-allowed disabled:opacity-50",
                destructive
                    ? "text-content-error hover:bg-bg-error"
                    : "text-content-default hover:bg-bg-muted hover:text-content-emphasis",
                selected && !destructive && "bg-bg-subtle text-content-emphasis",
                className,
            )}
            {...rest}
        >
            {icon ? (
                <span className="inline-flex size-4 shrink-0 items-center justify-center text-content-muted">
                    {icon}
                </span>
            ) : null}
            <span className="flex-1 truncate">{children}</span>
            {right ? (
                <span className="ml-2 inline-flex shrink-0 items-center text-content-subtle">
                    {right}
                </span>
            ) : null}
        </button>
    );
});

/** Horizontal separator inside a menu. */
function Separator({
    className,
    ...rest
}: HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            role="separator"
            data-popover-separator
            className={cn("-mx-1 my-1 h-px bg-border-subtle", className)}
            {...rest}
        />
    );
}

// ─── Composite export ─────────────────────────────────────────────

export const Popover = Object.assign(PopoverRoot, {
    Menu,
    Item,
    Separator,
});
