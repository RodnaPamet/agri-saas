/**
 * Shared UI utility hooks — Epic 60's canonical home.
 *
 * **Import convention:** every consumer should import from the barrel
 * (`@/components/ui/hooks`) rather than the per-file paths below. The
 * file layout is an implementation detail that can reshuffle without
 * touching call sites.
 *
 * See `./README.md` for the full architecture — category manifest,
 * SSR-safety conventions, naming rules, how this directory relates to
 * `src/lib/hooks/` (data-fetching / domain hooks, a separate home).
 *
 * The barrel is verified against every `use-*.ts(x)` file in this
 * directory by `tests/guards/ui-hooks-barrel.test.ts` — adding a hook
 * without a barrel export fails CI.
 */

// ─── Persistence ──────────────────────────────────────────────────────
export {
    useLocalStorage,
    type UseLocalStorageOptions,
} from "./use-local-storage";

// ─── Timing ───────────────────────────────────────────────────────────
export { useDebounce } from "./use-debounce";

// ─── Viewport / observer ──────────────────────────────────────────────
export { useInViewport } from "./use-in-viewport";
export { useIntersectionObserver } from "./use-intersection-observer";
export { useKeyboardInset, type KeyboardInset } from "./use-keyboard-inset";
export { useMediaQuery } from "./use-media-query";
export { useResizeObserver } from "./use-resize-observer";
export {
    useResponsivePresentation,
    resolvePresentation,
    type ResponsivePresentation,
    type UseResponsivePresentation,
    type UseResponsivePresentationOptions,
} from "./use-responsive-presentation";

// ─── Scroll ───────────────────────────────────────────────────────────
export { useScroll } from "./use-scroll";
export { useScrollProgress } from "./use-scroll-progress";

// ─── Optimistic UI ────────────────────────────────────────────────────
export {
    useOptimisticUpdate,
    type UseOptimisticUpdateOptions,
    type UseOptimisticUpdateResult,
} from "./use-optimistic-update";

// ─── Submit / input / keyboard ────────────────────────────────────────
export {
    useEnterSubmit,
    type EnterSubmitModifierPolicy,
    type UseEnterSubmitOptions,
    type UseEnterSubmitResult,
} from "./use-enter-submit";
export { useInputFocused } from "./use-input-focused";
export { useKeyboardShortcut } from "./use-keyboard-shortcut";

// ─── Dense-table ergonomics ───────────────────────────────────────────
export { useColumnVisibility } from "./use-column-visibility";

// ─── Clipboard / copy ─────────────────────────────────────────────────
export {
    useCopyToClipboard,
    type UseCopyToClipboardOptions,
    type UseCopyToClipboardResult,
    type CopyOptions,
    type CopyFn,
} from "./use-copy-to-clipboard";

// ─── Cursor pagination ────────────────────────────────────────────────
export {
    useCursorPagination,
    type UseCursorPaginationOptions,
    type UseCursorPaginationResult,
} from "./use-cursor-pagination";

// ─── Threshold load-more (PR-1) ───────────────────────────────────────
//
// Sibling of `useCursorPagination` — same `hasMore` + `loadMore`
// vocabulary, but slices an in-memory row list to a configurable
// threshold instead of fetching the next server cursor. Used by
// tenant tables that already have the full row set in memory and
// just want progressive disclosure for performance + scannability.
export {
    useThresholdLoadMore,
    DEFAULT_LOAD_MORE_THRESHOLD,
    type UseThresholdLoadMoreOptions,
    type UseThresholdLoadMoreResult,
} from "./use-threshold-load-more";

// ─── Celebration (Epic 62) ────────────────────────────────────────────
export {
    useCelebration,
    type CelebrateInput,
    type CelebrateAdHocInput,
    type UseCelebrationResult,
} from "./use-celebration";

// ─── View mode (Epic 66) ──────────────────────────────────────────────
export {
    useViewMode,
    viewModeStorageKey,
    type ViewMode,
} from "./use-view-mode";

// ─── Toast vocabulary (Roadmap-2 PR-9) ────────────────────────────────
export {
    useToast,
    type ToastApi,
    type ToastOptions,
} from "./use-toast";

// ─── Toast with undo (Epic 67) ────────────────────────────────────────
export {
    useToastWithUndo,
    cancelPendingUndoToast,
    type TriggerUndoToast,
    type TriggerUndoToastInput,
} from "./use-toast-with-undo";

// ─── Reduced motion (feat/delight-motion) ─────────────────────────────
export { useReducedMotion, prefersReducedMotion } from "./use-reduced-motion";

// ─── Pull-to-refresh (mobile-native-feel) ─────────────────────────────
export {
    usePullToRefresh,
    PullToRefresh,
    type UsePullToRefreshOptions,
    type UsePullToRefreshResult,
} from "./use-pull-to-refresh";
