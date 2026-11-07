/**
 * Epic 68 — `<VirtualizedList>` primitive.
 *
 * Render-level contract:
 *   - itemCount of 1000 with a small viewport renders only the
 *     visible window plus the configured overscan — never the
 *     full 1000 rows
 *   - scrolling shifts the rendered window
 *   - `itemSize` as a function feeds react-window v2's `List`
 *     `rowHeight` callback and respects per-index sizes
 *   - `renderItem` receives an index + a positional `style` whose
 *     `transform: translateY(...)` reflects the row's position
 *     (react-window v2 positions rows via transform, not `top`)
 *   - aria-label is forwarded to the inner scroll viewport
 *
 * jsdom has no layout engine — every test passes an explicit height
 * so react-window v2's `List` uses it as `defaultHeight` (the
 * pre-measurement / SSR initial) and renders the visible window
 * without a ResizeObserver firing. The auto-fill (ResizeObserver)
 * path is exercised at runtime in the rollout integration tests
 * (which mount inside sized containers).
 */
/** @jest-environment jsdom */

import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import { VirtualizedList } from "@/components/ui/virtualized-list";

function range(n: number): number[] {
    return Array.from({ length: n }, (_, i) => i);
}

function countRendered(testIdPrefix: string): number {
    return screen.queryAllByTestId(new RegExp(`^${testIdPrefix}-\\d+$`)).length;
}

describe("VirtualizedList — windowing contract", () => {
    it("renders only the visible window for a 1000-item list (not 1000 nodes)", () => {
        render(
            <VirtualizedList
                itemCount={1000}
                itemSize={30}
                height={300}
                width={400}
                renderItem={({ index, style }) => (
                    <div style={style} data-testid={`row-${index}`}>
                        Row {index}
                    </div>
                )}
            />,
        );

        // 300 / 30 = 10 visible rows. With default overscan of 2, the
        // primitive renders 10 + 2 = 12 rows max (overscan extends in
        // BOTH directions, but at scrollTop=0 the upper overscan is
        // outside the list).
        const rendered = countRendered("row");
        expect(rendered).toBeGreaterThan(0);
        expect(rendered).toBeLessThanOrEqual(15);
        expect(rendered).toBeLessThan(1000);

        // First few rows are present; deep rows are absent.
        expect(screen.getByTestId("row-0")).toBeInTheDocument();
        expect(screen.queryByTestId("row-500")).not.toBeInTheDocument();
        expect(screen.queryByTestId("row-999")).not.toBeInTheDocument();
    });

    it("scrolling shifts the rendered window", () => {
        const { container } = render(
            <VirtualizedList
                itemCount={1000}
                itemSize={30}
                height={300}
                width={400}
                renderItem={({ index, style }) => (
                    <div style={style} data-testid={`row-${index}`}>
                        Row {index}
                    </div>
                )}
            />,
        );

        // Starting state: row 0 visible.
        expect(screen.getByTestId("row-0")).toBeInTheDocument();

        // react-window v2's scroll container is the `List` root div
        // inside our wrapper. It carries `style.overflowY: auto` (v1
        // used the shorthand `overflow: auto`) so we identify it that
        // way.
        const all = Array.from(container.querySelectorAll("div"));
        const scrollContainer = all.find(
            (el) => (el as HTMLElement).style?.overflowY === "auto",
        ) as HTMLDivElement | undefined;
        expect(scrollContainer).toBeTruthy();

        // react-window's onScroll reads `event.currentTarget.scrollTop`
        // (not `target.scrollTop`), so we set the element's properties
        // directly and then dispatch the event. clientHeight + scrollHeight
        // are also read for range calculation; we provide them too.
        Object.defineProperty(scrollContainer!, "scrollTop", {
            configurable: true,
            value: 9000,
        });
        Object.defineProperty(scrollContainer!, "clientHeight", {
            configurable: true,
            value: 300,
        });
        Object.defineProperty(scrollContainer!, "scrollHeight", {
            configurable: true,
            value: 30000,
        });
        fireEvent.scroll(scrollContainer!);

        // After scrolling, row 0 is gone and rows around index 300
        // (9000 / 30) are visible.
        expect(screen.queryByTestId("row-0")).not.toBeInTheDocument();
        expect(screen.getByTestId("row-300")).toBeInTheDocument();
    });
});

describe("VirtualizedList — render contract", () => {
    it("passes an absolute-positioned style to renderItem", () => {
        render(
            <VirtualizedList
                itemCount={5}
                itemSize={50}
                height={300}
                width={400}
                renderItem={({ index, style }) => (
                    <div style={style} data-testid={`row-${index}`}>
                        Row {index}
                    </div>
                )}
            />,
        );

        const row1 = screen.getByTestId("row-1");
        // react-window v2 positions rows via `position: absolute` +
        // `transform: translateY(...)` (v1 used `top`).
        expect(row1.style.position).toBe("absolute");
        // Row 1 starts at 50px (1 * itemSize).
        expect(row1.style.transform).toBe("translateY(50px)");
    });

    it("forwards aria-label to the wrapper element", () => {
        // react-window's typed props don't accept arbitrary ARIA
        // attributes, so we set the label on the outer wrapper div
        // instead. Screen readers see the wrapper as the labelled
        // region and announce its name when focus enters.
        render(
            <VirtualizedList
                itemCount={10}
                itemSize={30}
                height={100}
                width={200}
                aria-label="Test virtualized rows"
                renderItem={({ index, style }) => (
                    <div style={style}>Row {index}</div>
                )}
            />,
        );

        const wrapper = document.querySelector(
            "[aria-label=\"Test virtualized rows\"]",
        );
        expect(wrapper).toBeTruthy();
        expect(wrapper?.getAttribute("data-virtualized-list")).toBe("");
    });

    it("forwards data-testid to the wrapper", () => {
        render(
            <VirtualizedList
                itemCount={5}
                itemSize={30}
                height={100}
                width={200}
                data-testid="my-list"
                renderItem={({ index, style }) => <div style={style}>{index}</div>}
            />,
        );

        expect(screen.getByTestId("my-list")).toBeInTheDocument();
    });
});

describe("VirtualizedList — variable size mode", () => {
    it("itemSize as a function feeds the List rowHeight callback and respects per-index sizes", () => {
        const sizes = [20, 60, 30, 100, 40];
        render(
            <VirtualizedList
                itemCount={sizes.length}
                itemSize={(i) => sizes[i] ?? 30}
                height={500}
                width={400}
                renderItem={({ index, style }) => (
                    <div style={style} data-testid={`row-${index}`}>
                        Row {index}
                    </div>
                )}
            />,
        );

        // All 5 rows fit in 500px (sum = 250) so all render.
        const row0 = screen.getByTestId("row-0");
        const row1 = screen.getByTestId("row-1");
        const row2 = screen.getByTestId("row-2");

        // v2 positions via `transform: translateY(...)`.
        // Row 1 starts at 20 (size[0]).
        expect(row1.style.transform).toBe("translateY(20px)");
        // Row 2 starts at 80 (20 + 60).
        expect(row2.style.transform).toBe("translateY(80px)");
        // Row 0 starts at 0.
        expect(row0.style.transform).toBe("translateY(0px)");
    });

    it("variable mode also windows large lists correctly", () => {
        render(
            <VirtualizedList
                itemCount={1000}
                itemSize={(i) => 25 + (i % 3) * 10}
                height={300}
                width={400}
                renderItem={({ index, style }) => (
                    <div style={style} data-testid={`vrow-${index}`}>
                        VRow {index}
                    </div>
                )}
            />,
        );
        const rendered = countRendered("vrow");
        expect(rendered).toBeGreaterThan(0);
        expect(rendered).toBeLessThan(50);
    });
});

describe("VirtualizedList — dynamic row height (#2797)", () => {
    it("renders with dynamicRowHeight and NO itemSize", () => {
        // The mode a chat timeline needs: bubble height depends on how text
        // wraps, which is not a deterministic function of the index. The
        // `renderItem` contract is unchanged — spread `style`, nothing else —
        // because `List` measures the row elements it already owns through
        // `observeRowElements`.
        render(
            <VirtualizedList
                itemCount={4}
                dynamicRowHeight={{ defaultRowHeight: 40 }}
                height={400}
                width={400}
                renderItem={({ index, style }) => (
                    <div style={style} data-testid={`dyn-${index}`}>
                        Row {index}
                    </div>
                )}
            />,
        );
        expect(screen.getByTestId("dyn-0")).toBeInTheDocument();
        expect(screen.getByTestId("dyn-3")).toBeInTheDocument();
        // Positioned from the pre-measurement estimate under jsdom, which has
        // no layout engine — so the assertion is that rows ARE positioned,
        // not that they are measured. Measurement is a ResizeObserver path and
        // belongs to a runtime test, the same caveat this file's header
        // already records for the auto-fill branch.
        expect(screen.getByTestId("dyn-1").style.transform).toBe("translateY(40px)");
    });

    it("still windows a large list in dynamic mode", () => {
        render(
            <VirtualizedList
                itemCount={1000}
                dynamicRowHeight={{ defaultRowHeight: 40 }}
                height={200}
                width={400}
                renderItem={({ index, style }) => (
                    <div style={style} data-testid={`dyn-big-${index}`}>
                        Row {index}
                    </div>
                )}
            />,
        );
        const rendered = screen.getAllByTestId(/^dyn-big-/);
        expect(rendered.length).toBeGreaterThan(0);
        expect(rendered.length).toBeLessThan(30);
    });

    it("THROWS when neither itemSize nor dynamicRowHeight is given", () => {
        // Loud rather than defaulted. A fallback height renders a list that
        // looks plausible and positions every row wrongly, which is precisely
        // the failure this primitive exists to prevent — and it would be
        // invisible in jsdom, where nothing measures.
        const quiet = jest.spyOn(console, "error").mockImplementation(() => {});
        expect(() =>
            render(
                <VirtualizedList
                    itemCount={3}
                    height={200}
                    width={400}
                    renderItem={({ index, style }) => <div style={style}>{index}</div>}
                />,
            ),
        ).toThrow(/itemSize.*dynamicRowHeight|dynamicRowHeight.*itemSize/);
        quiet.mockRestore();
    });

    it("a FIXED-size list is unaffected — the control", () => {
        // The extension must be additive: `Combobox` passes a number and must
        // keep behaving exactly as before.
        render(
            <VirtualizedList
                itemCount={3}
                itemSize={30}
                height={200}
                width={400}
                renderItem={({ index, style }) => (
                    <div style={style} data-testid={`fixed-${index}`}>
                        Row {index}
                    </div>
                )}
            />,
        );
        expect(screen.getByTestId("fixed-1").style.transform).toBe("translateY(30px)");
    });
});

describe("VirtualizedList — overscan", () => {
    it("renders extra rows above/below the visible window per overscanCount", () => {
        // Viewport 60px / itemSize 30px → 2 visible rows. Overscan 5
        // means up to 5 rows beyond the viewport in each direction
        // (clamped at the list edges).
        render(
            <VirtualizedList
                itemCount={100}
                itemSize={30}
                height={60}
                width={200}
                overscanCount={5}
                renderItem={({ index, style }) => (
                    <div style={style} data-testid={`o-${index}`}>
                        {index}
                    </div>
                )}
            />,
        );

        // 2 visible + 5 overscan after = ~7 rendered at scrollTop=0.
        // Don't assert an exact number — react-window's overscan
        // policy is "up to N", not "exactly N" — assert the band.
        const rendered = countRendered("o");
        expect(rendered).toBeGreaterThanOrEqual(2);
        expect(rendered).toBeLessThanOrEqual(10);
    });
});

describe("VirtualizedList — itemKey", () => {
    it("uses itemKey for stable row identity across re-renders", () => {
        const keys = ["a", "b", "c", "d", "e"];
        const { rerender } = render(
            <VirtualizedList
                itemCount={5}
                itemSize={30}
                height={200}
                width={200}
                itemKey={(i) => keys[i] ?? i}
                renderItem={({ index, style }) => (
                    <div style={style} data-testid={`k-${index}`}>
                        {keys[index]}
                    </div>
                )}
            />,
        );
        expect(screen.getByTestId("k-0")).toHaveTextContent("a");

        // A re-render with the SAME data — react-window keeps row
        // identity stable. We just confirm no crash and content
        // remains consistent.
        rerender(
            <VirtualizedList
                itemCount={5}
                itemSize={30}
                height={200}
                width={200}
                itemKey={(i) => keys[i] ?? i}
                renderItem={({ index, style }) => (
                    <div style={style} data-testid={`k-${index}`}>
                        {keys[index]}
                    </div>
                )}
            />,
        );
        expect(screen.getByTestId("k-0")).toHaveTextContent("a");
    });
});

describe("VirtualizedList — auto-fill (ResizeObserver) fallback", () => {
    it("renders without explicit dimensions and still windows (no AutoSizer, List self-measures)", () => {
        // react-window v2 dropped react-virtualized-auto-sizer — the
        // `List` self-measures its parent via a ResizeObserver and uses
        // `defaultHeight` (0 here) until measured. jsdom never fires the
        // observer, so the List falls back to a 0-height container. The
        // invariant that still matters: the wrapper renders without
        // throwing AND windowing caps the rendered rows far below the
        // 100 logical items (v2 renders only a tiny visible+overscan
        // band at 0 height, not all 100).
        const { container } = render(
            <VirtualizedList
                itemCount={100}
                itemSize={30}
                renderItem={({ index, style }) => (
                    <div style={style} data-testid={`row-${index}`}>
                        Row {index}
                    </div>
                )}
            />,
        );
        expect(container.querySelector("[data-virtualized-list]")).toBeTruthy();
        // Windowing holds even without explicit dimensions — nowhere
        // near 100 rows are in the DOM.
        const rendered = countRendered("row");
        expect(rendered).toBeLessThan(100);
    });

    it("explicit height + auto width path mounts and renders the visible window", () => {
        // Explicit height feeds `defaultHeight`; width fills the parent
        // (100%). react-window v2 renders rows from `defaultHeight`
        // alone — no width measurement needed for a vertical list.
        const range10 = range(10);
        const { container } = render(
            <VirtualizedList
                itemCount={range10.length}
                itemSize={30}
                height={200}
                renderItem={({ index, style }) => (
                    <div style={style}>Row {index}</div>
                )}
            />,
        );
        expect(container.querySelector("[data-virtualized-list]")).toBeTruthy();
    });
});
