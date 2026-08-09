'use client';

/**
 * Epic 46 — Generic expand-all / collapse-all practice for any
 * `<TreeView>` consumer.
 *
 * Reusable beyond the framework explorer: any caller that holds an
 * expansion `Set<string>` plus the total number of expandable nodes
 * can drop this in. The toggle owns no state of its own — it's a
 * tiny stateless practice that fires `onExpandAll` /
 * `onCollapseAll`. The tri-state visual (none / partial / all) is
 * derived from `expandedCount` vs `totalExpandable`.
 *
 * Inspired by the explorer-style pattern used in Vanta and Drata
 * for practice / requirement libraries — two compact buttons grouped
 * together, with the inactive side de-emphasised. Clearer than a
 * single toggle that hides one action behind state.
 */

import { cn } from '@/lib/cn';
import { useTranslations } from 'next-intl';
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { getExpandToggleState } from '@/lib/framework-tree/tree-helpers';

export interface TreeExpandCollapseToggleProps {
    /** Number of nodes currently expanded. */
    expandedCount: number;
    /** Number of nodes that COULD be expanded (have children). */
    totalExpandable: number;
    onExpandAll: () => void;
    onCollapseAll: () => void;
    /** Optional accessible labels — defaults to the obvious English. */
    expandLabel?: string;
    collapseLabel?: string;
    className?: string;
    /** Test/dom id; both buttons get suffixed `${id}-expand` / `${id}-collapse`. */
    id?: string;
}

export function TreeExpandCollapseToggle({
    expandedCount,
    totalExpandable,
    onExpandAll,
    onCollapseAll,
    expandLabel,
    collapseLabel,
    className,
    id = 'tree-toggle',
}: TreeExpandCollapseToggleProps) {
    const t = useTranslations('ui');
    const resolvedExpandLabel = expandLabel ?? t('tree.expandAll');
    const resolvedCollapseLabel = collapseLabel ?? t('tree.collapseAll');
    // Derive tri-state. Disabling the no-op direction makes the
    // affordance honest: when nothing's expanded, "Collapse all" is
    // pointless and clicking it would be confusing. The state
    // computation is a pure helper so the unit tests can cover it
    // without rendering the component.
    const state = getExpandToggleState(expandedCount, totalExpandable);
    const noWork = state === 'empty';
    const allExpanded = state === 'all';
    const noneExpanded = state === 'none' || noWork;

    return (
        <div
            className={cn(
                'inline-flex items-center rounded-md border border-border-default bg-bg-default',
                'divide-x divide-border-subtle overflow-hidden',
                className,
            )}
            role="group"
            aria-label={t('tree.practicesLabel')}
            data-tree-toggle-id={id}
        >
            <button
                type="button"
                onClick={onExpandAll}
                disabled={noWork || allExpanded}
                aria-label={resolvedExpandLabel}
                title={resolvedExpandLabel}
                id={`${id}-expand`}
                className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-colors',
                    'text-content-muted hover:text-content-emphasis hover:bg-bg-muted',
                    'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-default)] focus-visible:ring-inset',
                )}
            >
                <ChevronsUpDown className="w-3.5 h-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">{resolvedExpandLabel}</span>
            </button>
            <button
                type="button"
                onClick={onCollapseAll}
                disabled={noWork || noneExpanded}
                aria-label={resolvedCollapseLabel}
                title={resolvedCollapseLabel}
                id={`${id}-collapse`}
                className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-colors',
                    'text-content-muted hover:text-content-emphasis hover:bg-bg-muted',
                    'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-default)] focus-visible:ring-inset',
                )}
            >
                <ChevronsDownUp className="w-3.5 h-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">{resolvedCollapseLabel}</span>
            </button>
        </div>
    );
}
