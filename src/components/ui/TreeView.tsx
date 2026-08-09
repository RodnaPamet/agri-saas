'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/**
 * Epic 46 — generic, ARIA-compliant TreeView.
 *
 * Reusable beyond frameworks — any data shape that satisfies
 * `TreeViewNode` (id + optional children + optional hasChildren) can
 * render through this component. The framework viewer (next prompts
 * in this PR) is the first consumer, but asset hierarchies, practice
 * taxonomies, and org charts can drop in without changes.
 *
 * Key design decisions:
 *
 *   - Visible-flat materialisation. Every render derives a flat list
 *     of currently-visible rows from `(nodes, expanded)`. Render
 *     cost is O(visible), independent of total tree size. For trees
 *     up to ~5k visible rows this is the cheapest correct option;
 *     above that a windowed flattener can be swapped in without
 *     changing the public contract.
 *
 *   - Roving tabindex (one focusable element at a time). Only the
 *     row matching `focusedId` carries `tabIndex=0`; the rest are
 *     `-1`. Arrow / Home / End keys move focus along the visible-
 *     flat order without re-triggering `onSelect`. Click sets
 *     selection AND focus.
 *
 *   - Lazy children. If `loadChildren` is provided AND a node has
 *     `hasChildren=true` but `children?.length === 0`, expanding it
 *     calls `loadChildren(node)`. The container shows a spinner row
 *     while in flight; the parent receives the resolved children
 *     via `onChildrenLoaded` and is responsible for splicing them
 *     into its `nodes` prop on the next render. (Standard React
 *     "lift state up" — TreeView never owns the data.)
 *
 *   - Controlled OR uncontrolled expansion. Pass `expanded` +
 *     `onExpandedChange` for controlled mode, or `defaultExpanded`
 *     for uncontrolled. Mixed use is rejected at the type level.
 */

import { cn } from '@/lib/cn';
import { useTranslations } from 'next-intl';
import {
    type KeyboardEvent,
    type ReactNode,
    type Ref,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { TreeViewItem } from './TreeViewItem';
import {
    type FlatRow,
    flattenVisible,
    resolveTreeKey,
    toggleExpanded,
} from '@/lib/framework-tree/tree-helpers';
import type { TreeViewNode } from '@/lib/framework-tree/types';

// ─── Public props ──────────────────────────────────────────────────────

export interface TreeViewRenderContext {
    depth: number;
    expanded: boolean;
    selected: boolean;
    focusable: boolean;
    loading: boolean;
}

interface TreeViewBaseProps<T extends TreeViewNode> {
    nodes: ReadonlyArray<T>;
    /** Currently-selected node id. */
    selectedId?: string | null;
    onSelect?: (node: T) => void;
    /**
     * Lazy child loader. When provided, expanding a node whose
     * `hasChildren` is true but `children` is empty triggers this
     * callback. Resolved children should be merged into `nodes` by
     * the parent and passed back on the next render.
     */
    loadChildren?: (node: T) => Promise<ReadonlyArray<T>>;
    /** Called once a lazy load resolves; parent splices into `nodes`. */
    onChildrenLoaded?: (node: T, children: ReadonlyArray<T>) => void;
    /** Custom renderer for a single row. Defaults to `<TreeViewItem>`. */
    renderItem?: (node: T, ctx: TreeViewRenderContext) => ReactNode;
    /** Accessible name for the tree (e.g. "Framework requirements"). */
    ariaLabel?: string;
    className?: string;
    /** Forwarded ref for the tree container element. */
    treeRef?: Ref<HTMLDivElement>;
}

interface ControlledExpandedProps {
    expanded: ReadonlySet<string>;
    onExpandedChange: (next: ReadonlySet<string>) => void;
    defaultExpanded?: never;
}

interface UncontrolledExpandedProps {
    defaultExpanded?: ReadonlySet<string>;
    expanded?: never;
    onExpandedChange?: never;
}

export type TreeViewProps<T extends TreeViewNode> = TreeViewBaseProps<T> &
    (ControlledExpandedProps | UncontrolledExpandedProps);

// ─── Component ─────────────────────────────────────────────────────────

export function TreeView<T extends TreeViewNode>(props: TreeViewProps<T>) {
    const {
        nodes,
        selectedId = null,
        onSelect,
        loadChildren,
        onChildrenLoaded,
        renderItem,
        ariaLabel,
        className,
        treeRef,
    } = props;
    const t = useTranslations('ui');

    // Controlled / uncontrolled expansion.
    const isControlled = 'expanded' in props && props.expanded !== undefined;
    const [internalExpanded, setInternalExpanded] = useState<ReadonlySet<string>>(
        () => props.defaultExpanded ?? new Set<string>(),
    );
    const expanded = isControlled
        ? (props.expanded as ReadonlySet<string>)
        : internalExpanded;
    const setExpanded = useCallback(
        (next: ReadonlySet<string>) => {
            if (isControlled) {
                props.onExpandedChange?.(next);
            } else {
                setInternalExpanded(next);
            }
        },
        [isControlled, props],
    );

    // ── Lazy-load tracking ────────────────────────────────────────────
    // Set of node ids currently fetching children. Kept separate from
    // `expanded` so a re-render after expansion doesn't re-trigger the
    // fetch.
    const [loadingIds, setLoadingIds] = useState<ReadonlySet<string>>(
        () => new Set(),
    );
    const inFlightRef = useRef<Set<string>>(new Set());

    const triggerLazyLoad = useCallback(
        (node: T) => {
            if (!loadChildren) return;
            if (inFlightRef.current.has(node.id)) return;
            inFlightRef.current.add(node.id);
            setLoadingIds((prev) => {
                const next = new Set(prev);
                next.add(node.id);
                return next;
            });
            void Promise.resolve(loadChildren(node))
                .then((children) => {
                    onChildrenLoaded?.(node, children);
                })
                .finally(() => {
                    inFlightRef.current.delete(node.id);
                    setLoadingIds((prev) => {
                        if (!prev.has(node.id)) return prev;
                        const next = new Set(prev);
                        next.delete(node.id);
                        return next;
                    });
                });
        },
        [loadChildren, onChildrenLoaded],
    );

    // ── Materialise visible rows (memoised on nodes + expanded). ─────
    const rows = useMemo<FlatRow<T>[]>(
        () => flattenVisible(nodes, expanded),
        [nodes, expanded],
    );

    // ── Roving-tabindex focus model. ──────────────────────────────────
    // Default focus = first row (or selected, if visible).
    const initialFocus = useMemo(() => {
        if (selectedId && rows.some((r) => r.node.id === selectedId)) return selectedId;
        return rows[0]?.node.id ?? null;
    }, [rows, selectedId]);
    const [focusedId, setFocusedId] = useState<string | null>(initialFocus);

    // Keep focusedId valid across data changes.
    useEffect(() => {
        if (focusedId && rows.some((r) => r.node.id === focusedId)) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setFocusedId(initialFocus);
    }, [focusedId, rows, initialFocus]);

    // ── Imperative focus on row change. ───────────────────────────────
    const containerRef = useRef<HTMLDivElement | null>(null);
    // Forwarded-ref bridge: assign the resolved DOM node to both the
    // local ref AND the caller-supplied ref (function or object form).
    // Setting `.current` on a forwarded ref IS the documented contract
    // for ref forwarding; the Compiler rule's "treeRef cannot be
    // modified" is a false positive on the pattern. Both the
    // declaration line and the inner assignment trip the rule —
    // suppress both within one annotated block.
    /* eslint-disable react-hooks/immutability */
    const setContainerRef = useCallback(
        (el: HTMLDivElement | null) => {
            containerRef.current = el;
            if (typeof treeRef === 'function') treeRef(el);
            else if (treeRef) (treeRef as { current: HTMLDivElement | null }).current = el;
        },
        [treeRef],
    );
    /* eslint-enable react-hooks/immutability */
    const lastFocusMoveSourceRef = useRef<'keyboard' | 'init'>('init');

    // Move DOM focus to the row matching `focusedId` IFF the move
    // came from a keyboard interaction. Avoids stealing focus on
    // initial mount or on parent-driven `selectedId` changes.
    useEffect(() => {
        if (lastFocusMoveSourceRef.current !== 'keyboard') return;
        if (!focusedId || !containerRef.current) return;
        const el = containerRef.current.querySelector<HTMLElement>(
            `[data-tree-node-id="${CSS.escape(focusedId)}"]`,
        );
        el?.focus();
    }, [focusedId]);

    // ── Toggle handler (click on chevron OR ArrowRight/Left). ────────
    const handleToggle = useCallback(
        (node: T) => {
            const wasExpanded = expanded.has(node.id);
            setExpanded(toggleExpanded(expanded, node.id));
            // Lazy load on first expand if children are unloaded.
            const childCount = node.children?.length ?? 0;
            const hasChildren = node.hasChildren ?? childCount > 0;
            if (!wasExpanded && hasChildren && childCount === 0) {
                triggerLazyLoad(node);
            }
        },
        [expanded, setExpanded, triggerLazyLoad],
    );

    // ── Keyboard handler. ─────────────────────────────────────────────
    const handleKeyDown = useCallback(
        (e: KeyboardEvent<HTMLDivElement>) => {
            if (!focusedId) return;
            const effect = resolveTreeKey(e.key, focusedId, rows, expanded);
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                const row = rows.find((r) => r.node.id === focusedId);
                if (row) onSelect?.(row.node);
                return;
            }
            if (!effect) return;
            e.preventDefault();
            lastFocusMoveSourceRef.current = 'keyboard';
            switch (effect.type) {
                case 'focus':
                    setFocusedId(effect.id);
                    break;
                case 'expand': {
                    const node = rows.find((r) => r.node.id === effect.id)?.node;
                    if (node) handleToggle(node);
                    break;
                }
                case 'collapse': {
                    const node = rows.find((r) => r.node.id === effect.id)?.node;
                    if (node) handleToggle(node);
                    break;
                }
            }
        },
        [focusedId, rows, expanded, onSelect, handleToggle],
    );

    // ── Render ────────────────────────────────────────────────────────
    return (
        <div
            ref={setContainerRef}
            role="tree"
            aria-label={ariaLabel}
            onKeyDown={handleKeyDown}
            className={cn('flex flex-col', className)}
        >
            {rows.length === 0 ? (
                <div className="px-3 py-6 text-sm text-content-subtle text-center">
                    {t('treeView.empty')}
                </div>
            ) : (
                rows.map((row) => {
                    const node = row.node;
                    const childCount = node.children?.length ?? 0;
                    const hasChildren = node.hasChildren ?? childCount > 0;
                    const isExpanded = row.expanded;
                    const isSelected = node.id === selectedId;
                    const isFocusable = node.id === focusedId;
                    const isLoading = loadingIds.has(node.id);

                    if (renderItem) {
                        // Wrapper carries `data-tree-row-id` (NOT
                        // `data-tree-node-id`). The inner item set
                        // — typically `<TreeViewItem>` — is what
                        // owns `data-tree-node-id`. Two attributes
                        // for two different jobs:
                        //   - `data-tree-row-id` lets the TreeView
                        //     anchor virtualisation / measurement
                        //     hooks at the row level without
                        //     colliding with the inner item.
                        //   - `data-tree-node-id` on the inner item
                        //     remains the canonical selector for
                        //     IntersectionObserver, focus mgmt, and
                        //     E2E selectors.
                        // Pre-fix the wrapper carried both, which
                        // produced strict-mode locator violations
                        // on Playwright queries that hit BOTH the
                        // wrapper and the inner item.
                        return (
                            <div key={node.id} data-tree-row-id={node.id}>
                                {renderItem(node, {
                                    depth: row.depth,
                                    expanded: isExpanded,
                                    selected: isSelected,
                                    focusable: isFocusable,
                                    loading: isLoading,
                                })}
                            </div>
                        );
                    }

                    return (
                        <TreeViewItem
                            key={node.id}
                            id={node.id}
                            label={node.id}
                            depth={row.depth}
                            hasChildren={hasChildren}
                            expanded={isExpanded}
                            selected={isSelected}
                            focusable={isFocusable}
                            loading={isLoading}
                            onSelect={() => {
                                lastFocusMoveSourceRef.current = 'keyboard';
                                setFocusedId(node.id);
                                onSelect?.(node);
                            }}
                            onToggle={() => handleToggle(node)}
                        />
                    );
                })
            )}
        </div>
    );
}
