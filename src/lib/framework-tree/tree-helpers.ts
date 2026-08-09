/**
 * Epic 46 — pure helpers for the generic `<TreeView>`.
 *
 * Extracted into a standalone module so they can be unit-tested
 * without a DOM (the project doesn't ship `jest-environment-jsdom`).
 * The helpers are generic over any `TreeViewNode` — they don't know
 * or care about framework data.
 */

import type { TreeViewNode } from './types';

// ─── Visible-flat materialisation ──────────────────────────────────────

/**
 * One row in the rendered tree, with everything the renderer needs.
 *
 * Recomputed every render via `useMemo` keyed on
 * `(nodes, expanded)` — keeps the per-frame cost O(visible)
 * regardless of total tree size, which is the cheapest correct
 * baseline for trees up to ~5k visible rows. Above that, swap this
 * helper for a windowed flattener — the contract stays the same.
 */
export interface FlatRow<T extends TreeViewNode> {
    node: T;
    depth: number;
    expanded: boolean;
    /** Stable index in the visible-flat list — used for keyboard nav. */
    index: number;
    /** Path of ancestor ids (root first) — used for ARIA + focus. */
    parentIds: readonly string[];
}

export function flattenVisible<T extends TreeViewNode>(
    nodes: ReadonlyArray<T>,
    expanded: ReadonlySet<string>,
): FlatRow<T>[] {
    const out: FlatRow<T>[] = [];
    function walk(level: ReadonlyArray<T>, depth: number, parents: string[]) {
        for (const node of level) {
            const isExpanded = expanded.has(node.id);
            out.push({
                node,
                depth,
                expanded: isExpanded,
                index: out.length,
                parentIds: parents,
            });
            if (isExpanded && node.children && node.children.length > 0) {
                walk(node.children as ReadonlyArray<T>, depth + 1, [...parents, node.id]);
            }
        }
    }
    walk(nodes, 0, []);
    return out;
}

// ─── Whole-tree id collection ──────────────────────────────────────────

/**
 * Walk every node in the tree, return the set of ids that have at
 * least one child. Useful for "Expand All" / "Collapse All"
 * practices — passing `collectExpandableIds(nodes)` into the
 * `expanded` set expands the whole tree.
 */
export function collectExpandableIds<T extends TreeViewNode>(
    nodes: ReadonlyArray<T>,
): Set<string> {
    const out = new Set<string>();
    const stack: T[] = [...nodes];
    while (stack.length) {
        const n = stack.pop()!;
        if (n.children && n.children.length > 0) {
            out.add(n.id);
            for (const child of n.children) stack.push(child as T);
        }
    }
    return out;
}

// ─── Keyboard nav ──────────────────────────────────────────────────────

/**
 * Resolve the next focused id given a key event on a treeitem.
 *
 * Returns `null` when the key has no effect (so the caller can
 * choose whether to consume the event or let it bubble — most
 * callers always consume to keep page-scroll keys from doing
 * surprising things while focus is inside the tree).
 *
 * Implements the common subset of the WAI-ARIA Authoring Practices
 * tree-view keyboard contract:
 *
 *   ArrowDown  → next visible row
 *   ArrowUp    → previous visible row
 *   ArrowRight → expand collapsed parent OR move to first child
 *   ArrowLeft  → collapse expanded parent OR move to parent row
 *   Home       → first visible row
 *   End        → last visible row
 *
 * Returns either a focus shift or an expansion change — never both
 * in the same call. The caller composes them.
 */
export type TreeKeyEffect =
    | { type: 'focus'; id: string }
    | { type: 'expand'; id: string }
    | { type: 'collapse'; id: string };

export function resolveTreeKey<T extends TreeViewNode>(
    key: string,
    focusedId: string,
    rows: ReadonlyArray<FlatRow<T>>,
    expanded: ReadonlySet<string>,
): TreeKeyEffect | null {
    if (rows.length === 0) return null;
    const idx = rows.findIndex((r) => r.node.id === focusedId);
    if (idx < 0) return null;
    const row = rows[idx];

    switch (key) {
        case 'ArrowDown': {
            const next = rows[idx + 1];
            return next ? { type: 'focus', id: next.node.id } : null;
        }
        case 'ArrowUp': {
            const prev = rows[idx - 1];
            return prev ? { type: 'focus', id: prev.node.id } : null;
        }
        case 'Home':
            return { type: 'focus', id: rows[0].node.id };
        case 'End':
            return { type: 'focus', id: rows[rows.length - 1].node.id };
        case 'ArrowRight': {
            const hasChildren = row.node.hasChildren ?? (row.node.children?.length ?? 0) > 0;
            if (!hasChildren) return null;
            if (!expanded.has(focusedId)) return { type: 'expand', id: focusedId };
            // Already expanded — descend to first child if any
            const firstChild = row.node.children?.[0];
            return firstChild ? { type: 'focus', id: firstChild.id } : null;
        }
        case 'ArrowLeft': {
            const hasChildren = row.node.hasChildren ?? (row.node.children?.length ?? 0) > 0;
            if (hasChildren && expanded.has(focusedId)) {
                return { type: 'collapse', id: focusedId };
            }
            // Move to parent row if there is one.
            const parentId = row.parentIds[row.parentIds.length - 1];
            return parentId ? { type: 'focus', id: parentId } : null;
        }
        default:
            return null;
    }
}

// ─── Expand-all / collapse-all derivations ─────────────────────────────

export type ExpandToggleState = 'none' | 'partial' | 'all' | 'empty';

/**
 * Tri-state used by the `<TreeExpandCollapseToggle>` to disable
 * the no-op direction. Pulled into a pure helper so the
 * component test stays a pure function call instead of a render
 * (no `jest-environment-jsdom` in the project).
 */
export function getExpandToggleState(
    expandedCount: number,
    totalExpandable: number,
): ExpandToggleState {
    if (totalExpandable === 0) return 'empty';
    if (expandedCount >= totalExpandable) return 'all';
    if (expandedCount === 0) return 'none';
    return 'partial';
}

// ─── Subtree filtering ─────────────────────────────────────────────────

/**
 * Return a new tree containing only branches that include at least
 * one node satisfying `match`. Matched nodes keep their full
 * descendant subtree (so a code-search hit shows context underneath
 * the match, not just an isolated row).
 *
 * Used by the framework explorer's search box. Pure / structural
 * (preserves children references when nothing under a branch
 * changed, so React rendering can short-circuit).
 *
 * Generic over `FrameworkTreeNode`-shaped nodes (id + children +
 * standard metadata) so non-framework consumers can reuse it for
 * the same "filter a tree, keep ancestors of hits" pattern.
 */
export function filterTree<
    T extends TreeViewNode & { children: ReadonlyArray<T> },
>(nodes: ReadonlyArray<T>, match: (node: T) => boolean): T[] {
    const out: T[] = [];
    for (const node of nodes) {
        if (match(node)) {
            // Self-match: keep the whole subtree as-is.
            out.push(node);
            continue;
        }
        const filteredChildren = filterTree(node.children, match);
        if (filteredChildren.length > 0) {
            // Some descendant matched — synthesize a new node carrying
            // only the surviving branch. Cast is safe because we
            // structurally preserve every required property of T.
            out.push({ ...node, children: filteredChildren } as T);
        }
    }
    return out;
}

// ─── Expansion-set toggling ────────────────────────────────────────────

/**
 * Immutable add/remove helpers — TreeView consumers can pass the
 * result straight to `setExpanded`. Returns the same `prev` set
 * when no change is needed so React's referential-equality bailout
 * skips rerenders.
 */
export function toggleExpanded(
    prev: ReadonlySet<string>,
    id: string,
): ReadonlySet<string> {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
}

export function withExpanded(
    prev: ReadonlySet<string>,
    id: string,
    on: boolean,
): ReadonlySet<string> {
    if (on === prev.has(id)) return prev;
    const next = new Set(prev);
    if (on) next.add(id);
    else next.delete(id);
    return next;
}
