"use client";

/**
 * Epic 68 — `<VirtualizedList>` primitive.
 *
 * Reusable foundation for windowed rendering across the app.
 * Wraps `react-window` v2's single `List` component behind an
 * ergonomic, react-window-agnostic API so consumers (DataTable
 * bodies, Combobox dropdowns, CardList grids, future surfaces)
 * never import react-window directly. If we replace react-window
 * with a different windowing engine later, the swap happens in one
 * file.
 *
 * Contract — only THREE props are required:
 *   - `itemCount`     — total number of logical items
 *   - `itemSize`      — fixed pixel height OR `(index) => height` for
 *                       variable rows. react-window v2's `List`
 *                       accepts both a number and a function for
 *                       `rowHeight`, so there is no longer a separate
 *                       fixed/variable component to route to.
 *   - `renderItem`    — `({ index, style }) => ReactNode`. The `style`
 *                       MUST be applied to the rendered row's outer
 *                       element so react-window can absolute-position
 *                       it inside the scroll viewport.
 *
 * Sizing — react-window v2 changed the model. The `List` measures its
 * own parent via a ResizeObserver and fills the height defined by its
 * `style`. `defaultHeight` is the SSR / pre-measurement initial value.
 *
 *   - Both `height` + `width` provided  → the wrapper div is given an
 *                                         explicit `height`/`width` and
 *                                         `defaultHeight={height}` is
 *                                         forwarded so jsdom (which has
 *                                         no layout engine) still
 *                                         renders the visible window.
 *                                         Tests use this mode.
 *   - Either dimension omitted          → the wrapper fills its parent
 *                                         (`height: 100%` / `width:
 *                                         100%`) and the `List`
 *                                         self-measures via
 *                                         ResizeObserver. The parent
 *                                         MUST have a determinate size
 *                                         (e.g. flex-1, fixed height, or
 *                                         position constraints),
 *                                         otherwise the list collapses
 *                                         to 0px. `react-virtualized-
 *                                         auto-sizer` is no longer used
 *                                         — v2's built-in measurement
 *                                         replaces it.
 *
 * SSR / jsdom safety — without layout, the ResizeObserver never fires,
 * so the `List` falls back to `defaultHeight`. Production code paths
 * that omit explicit dimensions must mount inside a sized container
 * (the rollout docs spell out the exact pattern per host).
 *
 * What this is NOT — a 2D grid virtualizer (use `react-window`'s
 * `Grid` directly for those rare cases) and not a way to defer
 * rendering items by index range (it's a viewport-driven window, not a
 * paginator). Card-list rollouts that want to virtualize a 3-column
 * responsive grid group cards into rows-of-N before passing to this
 * primitive.
 */
import * as React from "react";
import {
    List,
    useDynamicRowHeight,
    type ListImperativeAPI,
    type RowComponentProps,
} from "react-window";

export interface VirtualizedListRenderArgs {
    /** Logical index of the item being rendered. */
    index: number;
    /** Absolute-positioning style — MUST be spread onto the outer element. */
    style: React.CSSProperties;
}

export interface VirtualizedListProps {
    /** Total number of items in the windowed list. */
    itemCount: number;
    /**
     * Pixel height of each row. Pass a number for fixed-size rows or a
     * function `(index) => number` for variable rows. react-window v2's
     * `List` accepts both forms via its `rowHeight` prop. The function
     * form is suitable when row heights vary by index but are
     * deterministic. For rows that have to be MEASURED, pass
     * `dynamicRowHeight` instead of this prop — see below. Do not reach for
     * react-window's `useDynamicRowHeight` at a call site: Epic 68's point is
     * that this file and `virtual-table-body.tsx` are the only two importers
     * of the windowing engine.
     */
    itemSize?: number | ((index: number) => number);
    /** Render the row at `index`. Spread `style` onto the outer element. */
    renderItem: (args: VirtualizedListRenderArgs) => React.ReactNode;
    /**
     * Explicit height. When provided, the wrapper is sized to it and
     * the value is forwarded as react-window's `defaultHeight` so jsdom
     * (no layout engine) still renders the visible window.
     */
    height?: number;
    /**
     * Explicit width. When provided, the wrapper is sized to it.
     * Strings (e.g. `"100%"`) are forwarded verbatim.
     */
    width?: number | string;
    /**
     * Extra rows rendered above/below the visible window. Default
     * matches react-window's default; bump to ~5 for surfaces with fast
     * keyboard navigation (combobox) so options pre-render before the
     * user scrolls them into view.
     */
    overscanCount?: number;
    /**
     * Measure each row instead of being told its height — P8.3 (#2797).
     *
     * `itemSize` covers fixed rows and rows whose height is a DETERMINISTIC
     * function of their index. A chat bubble is neither: its height depends on
     * how its text wraps at the current width, and an estimate there is not a
     * near-miss but a broken layout — react-window absolute-positions rows
     * from the size it is given, so a wrong number makes rows overlap or leave
     * gaps.
     *
     * When set, `rowHeight` becomes the `DynamicRowHeight` from react-window's
     * `useDynamicRowHeight`, which `List` measures through
     * `observeRowElements` on the row elements it already owns. So this changes
     * NOTHING about the `renderItem` contract — a consumer still spreads
     * `style` and nothing else.
     *
     * `defaultRowHeight` is the pre-measurement estimate: the height assumed
     * for rows not yet rendered, which decides how nearly-right the scrollbar
     * is before the reader gets to them.
     *
     * It lives HERE rather than in the consumer because Epic 68 allows exactly
     * two files to import react-window, and this is one of them. A chat
     * timeline calling `useDynamicRowHeight` itself would be a third seam and
     * would make a windowing-engine swap a three-file change.
     *
     * react-window's own note, worth repeating: dynamic heights are less
     * efficient than predetermined ones. Pass `itemSize` where the height is
     * knowable.
     */
    dynamicRowHeight?: { defaultRowHeight: number };
    /**
     * Stable per-index key for React reconciliation.
     *
     * NOTE: react-window v2's `List` no longer exposes an `itemKey`
     * prop — it keys rows by index internally. This field is kept for
     * API stability (so consumers don't need edits) but is no longer
     * forwarded to react-window. Lists that shuffle/sort should rely on
     * the `key` set inside their own `renderItem` output instead.
     */
    itemKey?: (index: number) => string | number;
    /** Class on the outer wrapper. */
    className?: string;
    /** Class on the inner scroll viewport (the react-window list element). */
    innerClassName?: string;
    /** Accessible label, forwarded to the inner scroll viewport. */
    "aria-label"?: string;
    /** Optional `data-testid` for the outer wrapper. */
    "data-testid"?: string;
}

// react-window v2 calls the row component with `{ index, style, ...rowProps }`.
// We deliberately don't expose the `rowProps` channel — consumers close
// over their own data via `renderItem`, which is simpler and keeps the
// primitive's API surface minimal. `rowProps` is therefore typed as an
// empty object and passed as `{}`.
type RowProps = RowComponentProps<Record<never, never>>;

/**
 * Imperative handle exposed via `ref={...}`. Primary use case is
 * scroll-to-active for keyboard-driven surfaces (combobox, menu).
 */
export interface VirtualizedListHandle {
    /** Scroll to bring item at `index` into the visible window. */
    scrollToItem: (index: number, align?: "auto" | "smart" | "center" | "end" | "start") => void;
    /** Scroll the viewport to a specific pixel offset. */
    scrollTo: (offset: number) => void;
    /**
     * Reset the cached item-size measurements.
     *
     * NO-OP under react-window v2 — the library recomputes row heights
     * from the `rowHeight` function automatically when it changes, so
     * there's no manual cache to invalidate (v1's `VariableSizeList`
     * required `resetAfterIndex`). Kept on the handle for API stability
     * so consumers don't branch by react-window version.
     */
    resetAfterIndex: (index: number) => void;
}

export const VirtualizedList = React.forwardRef<
    VirtualizedListHandle,
    VirtualizedListProps
>(function VirtualizedList(
    {
        itemCount,
        itemSize,
        renderItem,
        height,
        width,
        overscanCount = 2,
        dynamicRowHeight,
        // itemKey intentionally destructured-and-ignored: kept on the
        // public props for API stability but not forwarded (v2 keys by
        // index). See VirtualizedListProps.itemKey.
        itemKey: _itemKey,
        className,
        innerClassName,
        "aria-label": ariaLabel,
        "data-testid": testId,
    },
    ref,
) {
    // Memoise the row component so react-window doesn't tear down its
    // row instances on every render of the parent. v2 passes
    // `{ index, style, ...rowProps }`; we only use index + style and
    // forward them to the consumer's `renderItem`.
    const Row = React.useMemo(() => {
        const Component = ({ index, style }: RowProps): React.ReactElement => (
            <>{renderItem({ index, style })}</>
        );
        Component.displayName = "VirtualizedListRow";
        return Component;
    }, [renderItem]);

    // react-window v2's imperative API (`ListImperativeAPI`) exposes
    // `scrollToRow({ index, align, behavior })` and an `element` getter
    // for the scroll container. We map the primitive's stable handle
    // onto it below.
    const listRef = React.useRef<ListImperativeAPI>(null);

    React.useImperativeHandle(
        ref,
        () => ({
            scrollToItem: (index, align) =>
                listRef.current?.scrollToRow({ index, align }),
            scrollTo: (offset) =>
                listRef.current?.element?.scrollTo({ top: offset }),
            // No-op under v2 — see VirtualizedListHandle.resetAfterIndex.
            resetAfterIndex: () => {},
        }),
        [],
    );

    // `rowHeight` accepts BOTH a number and a function in v2; forward
    // whichever the consumer supplied. The function form is wrapped so
    // react-window's `(index, rowProps)` signature collapses to the
    // `(index)` shape our consumers expect.
    // The hook is called UNCONDITIONALLY — React admits no branch around a
    // hook — and its result is used only when the consumer asked for it. The
    // fallback keeps it valid for the fixed-size callers that never read it.
    const dynamic = useDynamicRowHeight({
        defaultRowHeight: dynamicRowHeight?.defaultRowHeight ?? 48,
    });

    const rowHeight = React.useMemo(() => {
        if (dynamicRowHeight) return dynamic;
        if (typeof itemSize === "function") return (index: number) => itemSize(index);
        if (typeof itemSize === "number") return itemSize;
        // Neither given. Thrown rather than defaulted: a silent fallback
        // height renders a list that looks plausible and positions every row
        // wrongly, which is the failure this primitive exists to prevent.
        throw new Error(
            "VirtualizedList: pass `itemSize` or `dynamicRowHeight` — " +
                "without one, row positions cannot be computed.",
        );
    }, [itemSize, dynamicRowHeight, dynamic]);

    const hasExplicitHeight = typeof height === "number";
    const hasExplicitWidth = typeof width !== "undefined";

    // The inner List fills the wrapper's height. `defaultHeight` is the
    // pre-measurement / SSR initial — under jsdom (no ResizeObserver
    // layout) it's the ONLY height the List ever sees, so passing the
    // explicit height here is what lets the windowing tests render rows.
    return (
        <div
            data-virtualized-list=""
            data-testid={testId}
            aria-label={ariaLabel}
            className={className}
            style={{
                width: hasExplicitWidth ? (width as string | number) : "100%",
                height: hasExplicitHeight ? height : "100%",
                minHeight: 0,
            }}
        >
            <List<Record<never, never>>
                listRef={listRef}
                rowComponent={Row}
                rowCount={itemCount}
                rowHeight={rowHeight}
                rowProps={{}}
                overscanCount={overscanCount}
                className={innerClassName}
                defaultHeight={hasExplicitHeight ? height : undefined}
                style={{ height: "100%" }}
            />
        </div>
    );
});
