'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/**
 * Epic 46 — Framework Explorer.
 *
 * Replaces the flat "Requirements" tab on the framework detail
 * page. Two-pane layout: the tree on the left (sections →
 * requirements [→ sub-requirements]) and a selected-node detail
 * panel on the right. Reuses the generic `<TreeView>` primitive +
 * the new `/tree` API.
 *
 * What it carries forward from the old flat view:
 *   - Search box (now filters the tree, expanding ancestors of any
 *     match so hits stay visible)
 *   - Mapped/unmapped indicator + practice count badge per row
 *   - Drilldown into mapped practices for a selected requirement
 *
 * What it adds:
 *   - Real hierarchy with section / requirement / sub-requirement
 *     nesting (3+ levels) drawn from the new tree API
 *   - Global Expand-all / Collapse-all toggle
 *   - Keyboard navigation + ARIA tree semantics inherited from
 *     `<TreeView>`
 *   - Stable side-panel detail view with description + linked
 *     practices
 *
 * Coverage data is reused from the existing
 * `/frameworks/<key>?action=coverage` endpoint — no new server
 * surface is needed for the mapped/unmapped indicators.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileText } from 'lucide-react';
import { TreeView } from '@/components/ui/TreeView';
import { TreeViewItem } from '@/components/ui/TreeViewItem';
import { TreeExpandCollapseToggle } from '@/components/ui/TreeExpandCollapseToggle';
import { ComplianceStatusIndicator } from '@/components/ui/ComplianceStatusIndicator';
import { FrameworkMinimap } from '@/components/ui/FrameworkMinimap';
import {
    collectExpandableIds,
    filterTree,
} from '@/lib/framework-tree/tree-helpers';
import type {
    ComplianceStatus,
    FrameworkTreeNode,
    FrameworkTreePayload,
} from '@/lib/framework-tree/types';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';

// ─── Coverage shapes (subset of the existing coverage usecase output) ──

interface PracticeMapping {
    requirementCode: string;
    practiceCode: string;
    practiceName: string;
    practiceStatus: string;
}
interface CoveragePayload {
    practiceMappings?: PracticeMapping[];
}

// ─── Props ─────────────────────────────────────────────────────────────

export interface FrameworkExplorerProps {
    tree: FrameworkTreePayload;
    coverage: CoveragePayload | null;
    /**
     * Callback when the user picks a requirement. The detail
     * panel renders inline — this is purely for parents that want
     * to react (e.g. URL sync). Selecting a section node is a no-op.
     */
    onRequirementSelected?: (node: FrameworkTreeNode) => void;
}

// ─── Component ─────────────────────────────────────────────────────────

export function FrameworkExplorer({
    tree,
    coverage,
    onRequirementSelected,
}: FrameworkExplorerProps) {
    const t = useTranslations('frameworkExplorer');
    // ── Derived: per-requirement practice mappings, keyed by code. ────
    // The coverage usecase keys by `requirementCode` (not id), so we
    // build a lookup once and reuse it on every selection.
    const practicesByCode = useMemo(() => {
        const map = new Map<string, PracticeMapping[]>();
        for (const m of coverage?.practiceMappings ?? []) {
            const list = map.get(m.requirementCode) ?? [];
            list.push(m);
            map.set(m.requirementCode, list);
        }
        return map;
    }, [coverage]);

    // ── Search → filtered tree + auto-expansion of matching paths. ───
    const [search, setSearch] = useState('');
    const trimmed = search.trim().toLowerCase();
    const filteredTree = useMemo(() => {
        if (!trimmed) return tree.nodes;
        return filterTree(tree.nodes, (node) => {
            // Sections only match if their LABEL matches — searching
            // "people" surfaces the whole PEOPLE theme. Requirements
            // match on code OR title.
            if (node.kind === 'section') {
                return node.label.toLowerCase().includes(trimmed);
            }
            return (
                (node.code ?? '').toLowerCase().includes(trimmed) ||
                node.title.toLowerCase().includes(trimmed)
            );
        });
    }, [tree.nodes, trimmed]);

    // ── Expansion state. ──────────────────────────────────────────────
    // While a search is active we auto-expand every matching ancestor
    // so hits are visible without the user clicking. When the search
    // clears, we restore the user's manual expansion (cached).
    const [userExpanded, setUserExpanded] = useState<ReadonlySet<string>>(
        () => new Set(),
    );
    const allExpandableIdsForSearch = useMemo(
        () => collectExpandableIds(filteredTree),
        [filteredTree],
    );
    const expanded: ReadonlySet<string> = trimmed
        ? allExpandableIdsForSearch
        : userExpanded;

    // Total expandable count (for the toggle's tri-state) is computed
    // off the UNFILTERED tree so disabling logic doesn't flicker as
    // the user types.
    const totalExpandable = useMemo(
        () => collectExpandableIds(tree.nodes).size,
        [tree.nodes],
    );

    const handleExpandedChange = useCallback(
        (next: ReadonlySet<string>) => {
            // Ignore writes while search-driven auto-expansion is in
            // effect — they'd be overwritten on the next render anyway.
            if (trimmed) return;
            setUserExpanded(next);
        },
        [trimmed],
    );

    const handleExpandAll = useCallback(() => {
        if (trimmed) {
            // Bail out of search first so the new expansion sticks.
            setSearch('');
        }
        setUserExpanded(collectExpandableIds(tree.nodes));
    }, [tree.nodes, trimmed]);

    const handleCollapseAll = useCallback(() => {
        if (trimmed) setSearch('');
        setUserExpanded(new Set());
    }, [trimmed]);

    // ── Selection. ────────────────────────────────────────────────────
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const selectedNode = useMemo(() => {
        if (!selectedId) return null;
        return findNodeById(tree.nodes, selectedId);
    }, [tree.nodes, selectedId]);

    const handleSelect = useCallback(
        (node: FrameworkTreeNode) => {
            setSelectedId(node.id);
            if (node.kind === 'requirement') {
                onRequirementSelected?.(node);
            }
        },
        [onRequirementSelected],
    );

    // Clear selection when the underlying framework changes.
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSelectedId(null);
        setUserExpanded(new Set());
    }, [tree.framework.id]);

    // ── Mapped/unmapped lookup for badges. ────────────────────────────
    const isMapped = useCallback(
        (code: string | undefined) => {
            if (!code) return false;
            return practicesByCode.has(code);
        },
        [practicesByCode],
    );

    // Ref to the tree's scroll container so the minimap can both
    // observe scroll position AND trigger scrollIntoView jumps.
    // Declared BEFORE the empty-state early return so the hook
    // call order stays stable across renders (rules-of-hooks).
    const treeScrollRef = useRef<HTMLDivElement | null>(null);

    // Minimap → tree handler: ensure the section is expanded so the
    // user lands on a populated row, not a collapsed header that
    // would immediately scroll out of view as the surrounding rows
    // re-flow.
    const handleMinimapJump = useCallback(
        (sectionId: string) => {
            if (trimmed) {
                // Search-active overrides expansion — the minimap
                // jump is the user's intent, so clear the search.
                setSearch('');
            }
            setUserExpanded((prev) => {
                if (prev.has(sectionId)) return prev;
                const next = new Set(prev);
                next.add(sectionId);
                return next;
            });
            setSelectedId(sectionId);
        },
        [trimmed],
    );

    // ── Empty state for the tree side. ────────────────────────────────
    if (tree.nodes.length === 0) {
        return (
            <div className={cn(cardVariants({ density: 'none' }), 'text-center py-10 text-content-subtle')} id="framework-explorer-empty">
                {t('empty')}
            </div>
        );
    }

    return (
        <div
            className="grid grid-cols-1 lg:grid-cols-[minmax(0,380px),12rem,1fr] gap-default"
            id="framework-explorer"
        >
            {/* ── Tree pane ── */}
            <div className={cn(cardVariants({ density: 'none' }), 'flex flex-col min-h-[24rem]')}>
                <div className="flex flex-wrap items-center gap-tight mb-3">
                    <input
                        type="text"
                        placeholder={t('searchPlaceholder')}
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="input flex-1 min-w-[10rem]"
                        id="framework-explorer-search"
                        aria-label={t('searchAria')}
                    />
                    <TreeExpandCollapseToggle
                        expandedCount={expanded.size}
                        totalExpandable={totalExpandable}
                        onExpandAll={handleExpandAll}
                        onCollapseAll={handleCollapseAll}
                        id="framework-explorer-toggle"
                    />
                </div>
                <div className="flex items-center justify-between text-xs text-content-subtle mb-2">
                    <span>
                        {t('totalsSummary', { sections: tree.totals.sections, requirements: tree.totals.requirements })}
                    </span>
                    {trimmed && (
                        <span className="text-[var(--brand-default)]">
                            {t('searchActive')}
                        </span>
                    )}
                </div>
                <div
                    ref={treeScrollRef}
                    className="flex-1 overflow-y-auto overflow-x-hidden -mx-2 px-1"
                    id="framework-explorer-tree-scroll"
                >
                    <TreeView
                        nodes={filteredTree}
                        expanded={expanded}
                        onExpandedChange={handleExpandedChange}
                        selectedId={selectedId}
                        onSelect={handleSelect}
                        ariaLabel={t('treeAria', { name: tree.framework.name })}
                        renderItem={(node, ctx) => (
                            <FrameworkTreeRow
                                node={node}
                                ctx={ctx}
                                isMapped={isMapped(node.code)}
                                mappedCount={
                                    node.code ? practicesByCode.get(node.code)?.length ?? 0 : 0
                                }
                                onToggle={() => {
                                    if (trimmed) return; // honour the search-active gate
                                    const next = new Set(expanded);
                                    if (next.has(node.id)) next.delete(node.id);
                                    else next.add(node.id);
                                    handleExpandedChange(next);
                                }}
                                onSelect={() => handleSelect(node)}
                            />
                        )}
                    />
                </div>
            </div>

            {/* ── Minimap (Epic 46.3) ── */}
            <div className="hidden lg:block">
                <FrameworkMinimap
                    nodes={tree.nodes}
                    scrollContainerRef={treeScrollRef}
                    onSectionSelected={handleMinimapJump}
                />
            </div>

            {/* ── Detail pane ── */}
            <div className={cn(cardVariants({ density: 'none' }), 'min-h-[24rem]')} id="framework-explorer-detail">
                {!selectedNode ? (
                    <div className="h-full flex flex-col items-center justify-center text-center text-content-subtle px-6 py-10">
                        <FileText className="w-8 h-8 mb-2 opacity-60" aria-hidden="true" />
                        <p className="text-sm font-medium text-content-muted">{t('selectRequirement')}</p>
                        <p className="text-xs mt-1 max-w-xs">
                            {t('selectRequirementHint')}
                        </p>
                    </div>
                ) : selectedNode.kind === 'section' ? (
                    <SectionDetail node={selectedNode} />
                ) : (
                    <RequirementDetail
                        node={selectedNode}
                        practices={practicesByCode.get(selectedNode.code ?? '') ?? []}
                    />
                )}
            </div>
        </div>
    );
}

// ─── Row renderer ──────────────────────────────────────────────────────

interface FrameworkTreeRowProps {
    node: FrameworkTreeNode;
    ctx: {
        depth: number;
        expanded: boolean;
        selected: boolean;
        focusable: boolean;
        loading: boolean;
    };
    isMapped: boolean;
    mappedCount: number;
    onToggle: () => void;
    onSelect: () => void;
}

function FrameworkTreeRow({
    node,
    ctx,
    isMapped,
    mappedCount,
    onToggle,
    onSelect,
}: FrameworkTreeRowProps) {
    const t = useTranslations('frameworkExplorer');
    // Epic 46.3 — compliance status comes from the server. Sections
    // get the aggregated status; requirements get their own. When
    // the tree was loaded without coverage context the status falls
    // back to `undefined` and we render the legacy mapped/unmapped
    // affordance — that's a safety net, not the happy path.
    const status: ComplianceStatus | undefined = node.complianceStatus;
    const isSection = node.kind === 'section';

    let indicator: React.ReactNode = null;
    let meta: React.ReactNode;

    if (isSection) {
        // Sections show the aggregated status as a small dot plus
        // the descendant count. Avoids the "Mapped (37)" green-bias
        // bug where a section with 30 in-progress practices looked
        // green just because every requirement had at least one
        // mapped practice.
        if (status) {
            indicator = (
                <ComplianceStatusIndicator status={status} mode="dot" />
            );
        }
        meta = (
            <span className="text-content-subtle text-[11px]">
                {node.descendantCount}
            </span>
        );
    } else {
        // Requirement rows: the dot encodes compliance status; the
        // meta badge shows the mapped-practices count when there is
        // one, otherwise the explicit "Unmapped" pill.
        if (status) {
            indicator = (
                <ComplianceStatusIndicator status={status} mode="dot" />
            );
            meta = isMapped ? (
                <span className="text-[10px] text-content-subtle tabular-nums">
                    {mappedCount}
                </span>
            ) : (
                <ComplianceStatusIndicator
                    status="gap"
                    mode="chip"
                    labelled={false}
                />
            );
        } else {
            // Coverage data missing — fall back to the prompt-2 affordance.
            meta = isMapped ? (
                <StatusBadge variant="success" size="sm">
                    {mappedCount}
                </StatusBadge>
            ) : (
                <StatusBadge variant="neutral" size="sm">
                    {t('unmapped')}
                </StatusBadge>
            );
        }
    }

    return (
        <TreeViewItem
            id={node.id}
            label={node.label}
            secondary={
                isSection ? null : (
                    <span className="inline-flex items-center gap-1.5">
                        {indicator}
                        <span>{node.title}</span>
                    </span>
                )
            }
            meta={
                isSection ? (
                    <span className="inline-flex items-center gap-1.5">
                        {indicator}
                        {meta}
                    </span>
                ) : (
                    meta
                )
            }
            depth={ctx.depth}
            hasChildren={node.hasChildren}
            expanded={ctx.expanded}
            selected={ctx.selected}
            focusable={ctx.focusable}
            loading={ctx.loading}
            onToggle={onToggle}
            onSelect={onSelect}
        />
    );
}

// ─── Detail-pane sub-components ────────────────────────────────────────

function SectionDetail({ node }: { node: FrameworkTreeNode }) {
    const t = useTranslations('frameworkExplorer');
    return (
        <div className="p-5">
            <p className="text-xs uppercase tracking-wider text-content-subtle mb-1">
                {t('section')}
            </p>
            <Heading level={2}>{node.label}</Heading>
            <p className="text-xs text-content-muted mt-2">
                {t('sectionReqCount', { count: node.descendantCount })}
            </p>
        </div>
    );
}

function RequirementDetail({
    node,
    practices,
}: {
    node: FrameworkTreeNode;
    practices: PracticeMapping[];
}) {
    const t = useTranslations('frameworkExplorer');
    return (
        <div className="p-5 space-y-default" id="framework-explorer-requirement-detail">
            <div>
                <p className="text-xs uppercase tracking-wider text-content-subtle mb-1">
                    {t('requirement')}
                </p>
                <div className="flex items-center gap-compact flex-wrap">
                    <code className="text-sm font-mono text-[var(--brand-default)]">
                        {node.code}
                    </code>
                    <Heading level={2}>
                        {node.title}
                    </Heading>
                    {node.complianceStatus && (
                        <ComplianceStatusIndicator
                            status={node.complianceStatus}
                            mode="chip"
                        />
                    )}
                </div>
            </div>

            {node.description && (
                <p className="text-sm text-content-muted whitespace-pre-line">
                    {node.description}
                </p>
            )}

            {node.children.length > 0 && (
                <div>
                    <p className="text-xs font-semibold text-content-subtle mb-2">
                        {t('subRequirements', { count: node.children.length })}
                    </p>
                    <ul className="space-y-1">
                        {node.children.map((c) => (
                            <li key={c.id} className="text-xs text-content-default">
                                <code className="font-mono text-[var(--brand-default)] mr-2">
                                    {c.code}
                                </code>
                                {c.title}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <div>
                <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-semibold text-content-subtle">
                        {t('mappedPractices', { count: practices.length })}
                    </p>
                    {practices.length === 0 && (
                        <span className="text-[10px] text-content-warning">{t('unmapped')}</span>
                    )}
                </div>
                {practices.length === 0 ? (
                    <p className="text-xs text-content-subtle italic">
                        {t('noMappedPractices')}
                    </p>
                ) : (
                    <ul className="space-y-1.5">
                        {practices.map((c, i) => (
                            <li
                                key={`${c.practiceCode}-${i}`}
                                className="flex items-center gap-tight text-xs"
                            >
                                <code className="font-mono text-[var(--brand-default)] truncate max-w-trunc-tight">
                                    {c.practiceCode}
                                </code>
                                <span className="text-content-default flex-1 truncate">
                                    {c.practiceName}
                                </span>
                                <StatusBadge variant={c.practiceStatus === 'IMPLEMENTED'
                                            ? 'success'
                                            : c.practiceStatus === 'IN_PROGRESS'
                                              ? 'warning'
                                              : 'info'} size="sm">
                                    {c.practiceStatus}
                                </StatusBadge>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}

// ─── Local utility ─────────────────────────────────────────────────────

function findNodeById(
    nodes: ReadonlyArray<FrameworkTreeNode>,
    id: string,
): FrameworkTreeNode | null {
    for (const n of nodes) {
        if (n.id === id) return n;
        const sub = findNodeById(n.children, id);
        if (sub) return sub;
    }
    return null;
}

// Re-export so callers that just want one import path can pull it
// from the explorer module.
export { TreeExpandCollapseToggle };
