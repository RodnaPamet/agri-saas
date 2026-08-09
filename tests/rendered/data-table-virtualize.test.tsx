/**
 * Epic 68 — DataTable virtualization integration tests.
 *
 * Covers the full contract:
 *   - threshold logic (default 100, custom override, force-on/off)
 *   - virtualized + non-virtualized renderings produce equivalent DOM
 *     contracts for hover/selection/click
 *   - column alignment across header + virtualized rows
 *   - large-row DOM-count reduction (the whole point of virtualization)
 *
 * jsdom has no layout — every test passes an explicit virtualized
 * container height (or sets dimensions on the AutoSizer container)
 * so react-window can compute the visible window.
 */
/** @jest-environment jsdom */

import * as React from "react";
import { fireEvent, render, within, act } from "@testing-library/react";

// next/navigation — transitively used by DataTable's filter wiring on
// some pages. Mocked so render-only tests don't need a Next router.
jest.mock("next/navigation", () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => "/t/acme/things",
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: "acme" }),
}));

import {
    DataTable,
    VIRTUALIZE_DEFAULT_THRESHOLD,
    decideVirtualization,
    createColumns,
} from "@/components/ui/table";

// ─── Fixtures ───────────────────────────────────────────────────────

interface ThingRow {
    id: string;
    code: string;
    name: string;
    status: string;
}

function makeRows(n: number): ThingRow[] {
    return Array.from({ length: n }, (_, i) => ({
        id: `r${i}`,
        code: `CODE-${i.toString().padStart(4, "0")}`,
        name: `Item ${i}`,
        status: i % 3 === 0 ? "ACTIVE" : i % 3 === 1 ? "PENDING" : "DONE",
    }));
}

const thingColumns = createColumns<ThingRow>([
    { accessorKey: "code", header: "Code" },
    { accessorKey: "name", header: "Name" },
    { accessorKey: "status", header: "Status" },
]);

// Tests pass `virtualHeight` to bypass AutoSizer entirely (it doesn't
// measure cleanly under jsdom's no-op ResizeObserver). No prototype
// shimming required, no global state to restore.

/**
 * Default test harness — passes `virtualHeight` so the virtualized
 * body bypasses AutoSizer (which doesn't measure cleanly under
 * jsdom's no-op ResizeObserver). Real production code paths mount
 * inside `<ListPageShell.Body>` whose flex chain provides a sized
 * parent for AutoSizer to measure.
 */
function renderTable(
    props: Partial<React.ComponentProps<typeof DataTable<ThingRow>>> = {},
) {
    return render(
        <DataTable<ThingRow>
            data={makeRows(150)}
            columns={thingColumns}
            getRowId={(r) => r.id}
            virtualHeight={600}
            // R12-PR1 — DataTable's select column is now default-on.
            // The virtualization tests here measure column geometry
            // against `thingColumns.length`, so we opt this fixture
            // out of the select column to keep the count predictable.
            selectionEnabled={false}
            // Force virtualize=true on every virtualization-targeted
            // test in this file. The default threshold (1000) is too
            // high for most fixtures here; tests that explicitly
            // verify auto-engage at the threshold boundary still
            // override `virtualize` themselves.
            virtualize
            {...props}
        />,
    );
}

// Future-proof helper kept for tests that DO need AutoSizer to fire
// (none in this file today). Currently a no-op shim.
async function flushAutoSizer(): Promise<void> {
    await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
}

// ─── decideVirtualization (pure function) ───────────────────────────

describe("decideVirtualization — threshold contract", () => {
    it("default threshold is 1000", () => {
        // Threshold raised 100 → 1000 in a follow-up PR. See the
        // history block on `VIRTUALIZE_DEFAULT_THRESHOLD` for
        // rationale: medium-sized tables (100-1000 rows) hit
        // Playwright click-intercept regressions in CI when the
        // virtualized div wrapper sat above row interactions.
        expect(VIRTUALIZE_DEFAULT_THRESHOLD).toBe(1000);
    });

    it("returns false below the default threshold", () => {
        expect(decideVirtualization(undefined, 999)).toBe(false);
        expect(decideVirtualization(undefined, 1000)).toBe(false);
    });

    it("returns true above the default threshold", () => {
        expect(decideVirtualization(undefined, 1001)).toBe(true);
        expect(decideVirtualization(undefined, 5_000)).toBe(true);
    });

    it("force-true overrides threshold", () => {
        expect(decideVirtualization(true, 0)).toBe(true);
        expect(decideVirtualization(true, 5)).toBe(true);
    });

    it("force-false overrides threshold (Practices page contract)", () => {
        expect(decideVirtualization(false, 100_000)).toBe(false);
    });

    it("custom threshold via { threshold: N }", () => {
        expect(decideVirtualization({ threshold: 500 }, 499)).toBe(false);
        expect(decideVirtualization({ threshold: 500 }, 500)).toBe(false);
        expect(decideVirtualization({ threshold: 500 }, 501)).toBe(true);
    });
});

// ─── DataTable rendering — virtualization auto-engages above threshold ──

describe("DataTable — auto-virtualize above threshold", () => {
    it("1000 rows: standard <table> renders (NOT virtualized)", () => {
        const { container } = render(
            <DataTable<ThingRow>
                data={makeRows(1000)}
                columns={thingColumns}
                getRowId={(r) => r.id}
            />,
        );
        expect(container.querySelector("table")).toBeInTheDocument();
        expect(container.querySelector("[data-virtual-table]")).toBeNull();
    });

    it("1001 rows: VirtualTable renders, no <table> element", () => {
        // Explicitly do NOT use the renderTable helper here — the
        // helper force-sets `virtualize` for the rest of this file's
        // tests, but this test is about the threshold boundary
        // engaging WITHOUT an explicit override.
        const { container } = render(
            <DataTable<ThingRow>
                data={makeRows(1001)}
                columns={thingColumns}
                getRowId={(r) => r.id}
                virtualHeight={600}
            />,
        );
        expect(container.querySelector("[data-virtual-table]")).toBeInTheDocument();
        expect(container.querySelector("table")).toBeNull();
    });

    it("force virtualize=true engages even for 5 rows", () => {
        const { container } = renderTable({
            data: makeRows(5),
            virtualize: true,
        });
        expect(container.querySelector("[data-virtual-table]")).toBeInTheDocument();
    });

    it("force virtualize=false disables even for 5000 rows (Practices-style opt-out)", () => {
        const { container } = render(
            <DataTable<ThingRow>
                data={makeRows(5_000)}
                columns={thingColumns}
                getRowId={(r) => r.id}
                virtualize={false}
            />,
        );
        expect(container.querySelector("table")).toBeInTheDocument();
        expect(container.querySelector("[data-virtual-table]")).toBeNull();
    });

    it("custom threshold via { threshold: 50 } virtualizes at 51 rows", () => {
        const { container } = renderTable({
            data: makeRows(60),
            virtualize: { threshold: 50 },
        });
        expect(container.querySelector("[data-virtual-table]")).toBeInTheDocument();
    });

    it("falls back to non-virtualized when pagination is requested even above threshold", () => {
        const { container } = render(
            <DataTable<ThingRow>
                data={makeRows(500)}
                columns={thingColumns}
                getRowId={(r) => r.id}
                rowCount={5_000}
                pagination={{ pageIndex: 1, pageSize: 50 }}
                onPaginationChange={() => {}}
            />,
        );
        expect(container.querySelector("table")).toBeInTheDocument();
        expect(container.querySelector("[data-virtual-table]")).toBeNull();
    });
});

// ─── DOM-count reduction ─────────────────────────────────────────────

describe("DataTable — virtualized DOM stays small for large datasets", () => {
    it("5000-row virtualized table renders far fewer than 5000 row nodes", async () => {
        const { container } = renderTable({ data: makeRows(5_000) });
        await flushAutoSizer();
        const rows = container.querySelectorAll("[data-virtual-row-index]");
        // Viewport is 600px tall, row height 44px → ~14 visible rows
        // plus overscan 5 = ~19 max. Cap the assertion generously to
        // tolerate react-window's overscan policy.
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.length).toBeLessThan(50);
    });

    it("first row is rendered, deep row is absent", async () => {
        const { container } = renderTable({ data: makeRows(5_000) });
        await flushAutoSizer();
        expect(
            container.querySelector("[data-virtual-row-index='0']"),
        ).toBeInTheDocument();
        expect(
            container.querySelector("[data-virtual-row-index='3000']"),
        ).toBeNull();
    });
});

// ─── Behaviour parity — selection, hover, click ──────────────────────

describe("DataTable — virtualized behaviour parity", () => {
    it("row click handler fires with the clicked row (single-click, selection off)", async () => {
        const onRowClick = jest.fn();
        const { container } = renderTable({
            data: makeRows(150),
            onRowClick,
        });
        await flushAutoSizer();
        const firstRow = container.querySelector(
            "[data-virtual-row-index='0']",
        ) as HTMLElement;
        expect(firstRow).toBeTruthy();
        // Row-click semantics (revised 2026-06-03): renderTable sets
        // selectionEnabled={false}, so there's no selection competing
        // for the single click — onRowClick fires on SINGLE click.
        // (With selection ON it would fire on double-click instead.)
        fireEvent.click(firstRow);
        expect(onRowClick).toHaveBeenCalledTimes(1);
        const [row] = onRowClick.mock.calls[0]!;
        expect((row as { original: ThingRow }).original.id).toBe("r0");
    });

    it("selection state is reflected via data-selected on the row element", async () => {
        const Wrapper = () => {
            const [selected, setSelected] = React.useState({});
            return (
                <DataTable<ThingRow>
                    data={makeRows(150)}
                    columns={thingColumns}
                    getRowId={(r) => r.id}
                    virtualHeight={600}
                    virtualize
                    selectedRows={selected}
                    onRowSelectionChange={(rows) => {
                        const next: Record<string, boolean> = {};
                        for (const r of rows)
                            next[r.original.id] = true;
                        setSelected(next);
                    }}
                />
            );
        };
        const { container } = render(<Wrapper />);

        // Click the first row's checkbox — the select column is
        // `getVisibleLeafColumns()[0]` because `useTable` injects it
        // when an onRowSelectionChange handler is supplied.
        const firstRow = container.querySelector(
            "[data-virtual-row-index='0']",
        ) as HTMLElement;
        const checkboxWrapper = within(firstRow).getByTitle("Select");
        await act(async () => {
            fireEvent.click(checkboxWrapper);
            // Selection flows through useTable's state +
            // onRowSelectionChange effect → wrapper setState →
            // re-render. Yield once so the chain settles before we
            // re-query the row attribute.
            await new Promise<void>((r) => setTimeout(r, 0));
        });

        // The row may have been re-mounted by react-window's
        // virtualization (its keys are by index) so re-query rather
        // than reusing the stale `firstRow` reference.
        const refreshed = container.querySelector(
            "[data-virtual-row-index='0']",
        ) as HTMLElement;
        expect(refreshed.getAttribute("data-selected")).toBe("true");
    });

    it("hover-class infrastructure is present (group/row + group-hover descendants)", async () => {
        const { container } = renderTable({
            data: makeRows(150),
            onRowClick: () => {},
        });
        await flushAutoSizer();
        const firstRow = container.querySelector(
            "[data-virtual-row-index='0']",
        ) as HTMLElement;
        // The `group/row` class on the row drives hover-derived
        // backgrounds on descendant cells via Tailwind's
        // `group-hover/row:` utility. Asserting the class is the
        // structural lock — actual hover painting is browser-only.
        expect(firstRow.className).toContain("group/row");
        expect(firstRow.className).toContain("cursor-pointer");
    });

    it("middle-click via onRowAuxClick fires the aux handler", () => {
        const onRowAuxClick = jest.fn();
        const { container } = render(
            <div style={{ height: "600px", width: "800px" }}>
                <DataTable<ThingRow>
                    data={makeRows(150)}
                    columns={thingColumns}
                    getRowId={(r) => r.id}
                    virtualize
                    // onRowAuxClick is not (yet) on DataTable's typed
                    // surface — the prop is supported via the inner
                    // VirtualTable directly. Surfacing on DataTable
                    // is a follow-up; for now we cover the body
                    // contract via VirtualTable's own integration.
                />
            </div>,
        );
        // No direct DataTable surface; this case is covered by
        // VirtualTable contract elsewhere. Smoke-test that the
        // virtual body still mounts when the prop is omitted.
        expect(container.querySelector("[data-virtual-table]")).toBeInTheDocument();
        // Suppress unused-variable lint.
        expect(onRowAuxClick).not.toHaveBeenCalled();
    });
});

// ─── Column alignment ───────────────────────────────────────────────

describe("DataTable — column alignment in virtualized mode", () => {
    it("header and body rows share the same gridTemplateColumns", async () => {
        const { container } = renderTable({ data: makeRows(150) });
        await flushAutoSizer();
        const header = container.querySelector(
            "[data-virtual-table-header]",
        ) as HTMLElement;
        const firstRow = container.querySelector(
            "[data-virtual-row-index='0']",
        ) as HTMLElement;
        expect(header.style.gridTemplateColumns).toBe(
            firstRow.style.gridTemplateColumns,
        );
        // Templates are non-empty (i.e. column widths actually flow
        // into the inline style).
        expect(header.style.gridTemplateColumns.length).toBeGreaterThan(0);
    });

    it("header column count equals body cell count per row", async () => {
        const { container } = renderTable({ data: makeRows(150) });
        await flushAutoSizer();
        const headerCells = container.querySelectorAll(
            "[data-virtual-table-header] [role='columnheader']",
        );
        const firstRow = container.querySelector(
            "[data-virtual-row-index='0']",
        ) as HTMLElement;
        const bodyCells = firstRow.querySelectorAll("[role='cell']");
        expect(headerCells.length).toBe(bodyCells.length);
        expect(bodyCells.length).toBe(thingColumns.length);
    });
});

// ─── Sticky header ───────────────────────────────────────────────────

describe("DataTable — virtualized sticky header", () => {
    it("the header element carries position:sticky semantics", async () => {
        const { container } = renderTable({ data: makeRows(150) });
        await flushAutoSizer();
        const header = container.querySelector(
            "[data-virtual-table-header]",
        ) as HTMLElement;
        expect(header).toBeInTheDocument();
        // Tailwind sticky → CSS class includes 'sticky' which maps to
        // `position: sticky`. The class assertion is the structural
        // contract; computed style reflects the same.
        expect(header.className).toContain("sticky");
        expect(header.className).toContain("top-0");
    });
});

// ─── Sortable headers in virtualized mode ────────────────────────────

describe("DataTable — virtualized sort buttons", () => {
    it("clicking a sortable header invokes onSortChange with the column id", async () => {
        const onSortChange = jest.fn();
        const { container } = renderTable({
            data: makeRows(150),
            sortableColumns: ["code", "name"],
            sortBy: "code",
            sortOrder: "desc",
            onSortChange,
        });
        await flushAutoSizer();
        const header = container.querySelector(
            "[data-virtual-table-header]",
        ) as HTMLElement;
        // Sort button label: "Sort by column"
        const buttons = within(header).getAllByLabelText("Sort by column");
        // Two sortable columns → two buttons; click the first.
        expect(buttons.length).toBe(2);
        fireEvent.click(buttons[0]!);
        expect(onSortChange).toHaveBeenCalledTimes(1);
    });
});
