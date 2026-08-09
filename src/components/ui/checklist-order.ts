'use client';

/**
 * Shared click-to-order model for the gear dropdowns (2026-06-07).
 *
 * Both the "Edit filter cards" gear and the "Toggle columns" gear let the
 * user practice BOTH visibility AND left-to-right order from one checklist.
 * The interaction (user choice): **click-to-order, no drag** —
 *
 *   - State is a single `order: string[]` of the VISIBLE item ids, in
 *     sequence. The 1-based index is the number badge shown on the row
 *     and the left-to-right position of the card/column.
 *   - Toggling a hidden item ON appends its id (it gets the next number).
 *   - Toggling a visible item OFF removes its id (the rest renumber).
 *   - Reset restores the default order (all items visible, default order).
 *
 * `ChecklistGearButton` renders the items; this module owns the pure
 * order/visibility transforms so `useFilterCardVisibility` and
 * `useColumnsDropdown` share one implementation (zero duplication).
 */
import type { ReactNode } from 'react';

/** One row in a gear checklist — already resolved to its display state. */
export interface ChecklistGearItem {
    id: string;
    label: string;
    icon?: ReactNode;
    /** Whether the item is currently shown (in `order`). */
    visible: boolean;
    /** 1-based position among visible items; `null` when hidden. */
    order: number | null;
}

/** Minimal definition a caller maps into the checklist. */
export interface ChecklistDef {
    id: string;
    label: string;
    icon?: ReactNode;
}

/** The default order: every def, in declaration order, all visible. */
export function defaultOrder(defs: ReadonlyArray<{ id: string }>): string[] {
    return defs.map((d) => d.id);
}

/**
 * Toggle an id's membership in the visible order. Hidden → appended to the
 * end (next number); visible → removed (the rest renumber implicitly).
 */
export function toggleOrder(order: ReadonlyArray<string>, id: string): string[] {
    return order.includes(id)
        ? order.filter((x) => x !== id)
        : [...order, id];
}

/**
 * Reconcile a persisted order against the live def list by DROPPING ids
 * that no longer exist. It deliberately does NOT append defs absent from
 * the order — a def can be absent because the user HID it, and re-adding
 * it would silently un-hide it on every load. New defs (e.g. a filter
 * shipped in a release) surface as toggleable-OFF rows via
 * `buildChecklistItems` instead, so the user opts them in. Returns the
 * input array identity when nothing was dropped (stable for memo/deps).
 */
export function reconcileOrder(
    order: ReadonlyArray<string>,
    defs: ReadonlyArray<{ id: string }>,
): string[] {
    // Defensive: a persisted value from BEFORE the gear shipped is a
    // TanStack VisibilityState OBJECT (`{ id: bool }`), not an order array
    // — reusing the `inflect:col-vis:<entity>` key means old browsers hand
    // us that shape. Fall back to the default order rather than crashing on
    // `.filter` ("e.filter is not a function"). The next toggle persists the
    // new array shape, migrating the user forward.
    if (!Array.isArray(order)) {
        return defs.map((d) => d.id);
    }
    const live = new Set(defs.map((d) => d.id));
    const kept = order.filter((id) => live.has(id));
    // `filter` preserves order, so equal length ⇒ nothing dropped ⇒ identical.
    return kept.length === order.length ? (order as string[]) : kept;
}

/**
 * Drag-to-reorder: move `fromId` to `toId`'s position (inserted before it).
 * Both must be in the order (visible) — dropping onto a hidden row is a
 * no-op. Returns the input identity when nothing moves.
 */
export function reorderOrder(
    order: ReadonlyArray<string>,
    fromId: string,
    toId: string,
): string[] {
    if (
        fromId === toId ||
        !order.includes(fromId) ||
        !order.includes(toId)
    ) {
        return order as string[];
    }
    const without = order.filter((id) => id !== fromId);
    const toIdx = without.indexOf(toId);
    return [...without.slice(0, toIdx), fromId, ...without.slice(toIdx)];
}

/** True when the order differs from default (hidden OR reordered). */
export function isModifiedFromDefault(
    order: ReadonlyArray<string>,
    defaults: ReadonlyArray<string>,
): boolean {
    return (
        order.length !== defaults.length ||
        order.some((id, i) => id !== defaults[i])
    );
}

/** A column's effective id (TanStack derives it from `accessorKey`). */
function columnId(col: object): string | undefined {
    if ('id' in col && typeof (col as { id?: unknown }).id === 'string') {
        return (col as { id: string }).id;
    }
    if (
        'accessorKey' in col &&
        typeof (col as { accessorKey?: unknown }).accessorKey === 'string'
    ) {
        return (col as { accessorKey: string }).accessorKey;
    }
    return undefined;
}

/**
 * Reorder a column array so the ids in `order` follow that sequence while
 * keeping every OTHER column pinned to its position (the slot-merge): the
 * managed columns are rearranged among the slots they originally occupied,
 * so fixed columns (select / actions / always-visible) never move. Columns
 * not in `order` (incl. hidden managed ones) keep their place — visibility
 * hides them separately.
 */
export function applySlotOrder<T extends object>(
    columns: ReadonlyArray<T>,
    order: ReadonlyArray<string>,
): T[] {
    const wanted = new Set(order);
    const slots: number[] = [];
    columns.forEach((c, i) => {
        const id = columnId(c);
        if (id && wanted.has(id)) slots.push(i);
    });
    const byId = new Map<string, T>();
    columns.forEach((c) => {
        const id = columnId(c);
        if (id) byId.set(id, c);
    });
    const result = [...columns];
    order.forEach((id, k) => {
        if (k < slots.length) {
            const col = byId.get(id);
            if (col) result[slots[k]] = col;
        }
    });
    return result;
}

/**
 * Build the display rows: visible items first (in `order`, numbered 1..k),
 * then hidden items (in their default def order, no number).
 */
export function buildChecklistItems(
    defs: ReadonlyArray<ChecklistDef>,
    order: ReadonlyArray<string>,
): ChecklistGearItem[] {
    const byId = new Map(defs.map((d) => [d.id, d]));
    const visible: ChecklistGearItem[] = [];
    order.forEach((id, i) => {
        const d = byId.get(id);
        if (d) visible.push({ ...d, visible: true, order: i + 1 });
    });
    const orderSet = new Set(order);
    const hidden: ChecklistGearItem[] = defs
        .filter((d) => !orderSet.has(d.id))
        .map((d) => ({ ...d, visible: false, order: null }));
    return [...visible, ...hidden];
}
