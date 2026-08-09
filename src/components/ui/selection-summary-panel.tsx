'use client';

/**
 * `<SelectionSummaryPanel>` — rail content for the multi-select
 * selection-summary use case.
 *
 * Right-rail roadmap, Phase 2 (see `docs/right-rail-aside-roadmap.md`,
 * use case 4). When a list page has rows selected, this panel — docked
 * in the `aside` slot of `<ListPageShell>` / `<EntityListPage>` inside
 * an `<AsidePanel>` — summarises the selection and offers the batch
 * verbs. A calmer, persistent home than a floating bulk-action toolbar
 * that appears and vanishes on every selection change.
 *
 * This is the *content*; `<AsidePanel>` is the *chrome* (collapse,
 * `<Sheet>` fallback). State ownership: the consuming page owns the
 * selection state and the verb callbacks; this component is pure
 * presentation.
 */
import { type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';

export interface SelectionSummaryAction {
    /** Verb label — follows the destructive-action vocabulary where it bites. */
    label: string;
    /** Optional leading icon node. */
    icon?: ReactNode;
    /** Invoked with no args — the page closes over the current selection. */
    onClick: () => void;
    /** `'danger'` renders the destructive button variant. */
    tone?: 'default' | 'danger';
}

export interface SelectionSummaryPanelProps {
    /** Number of currently selected rows. */
    count: number;
    /**
     * Singular / plural resource words, e.g.
     * `{ singular: 'practice', plural: 'practices' }`. The panel picks
     * by `count`.
     */
    resourceLabel: { singular: string; plural: string };
    /**
     * Batch verbs offered for the current selection. An empty list (or
     * omitted) drops the verb section — e.g. a viewer without edit
     * permission still sees the count but no actions.
     */
    actions?: SelectionSummaryAction[];
    /** Clears the selection. */
    onClear: () => void;
}

export function SelectionSummaryPanel({
    count,
    resourceLabel,
    actions = [],
    onClear,
}: SelectionSummaryPanelProps) {
    const t = useTranslations('ui.selectionSummary');
    const word = count === 1 ? resourceLabel.singular : resourceLabel.plural;

    return (
        <div className="space-y-default" data-testid="selection-summary">
            {/* Count headline — aria-live so screen-reader users hear
                the selection size change without moving focus. */}
            <p
                className="flex items-baseline gap-tight"
                aria-live="polite"
                data-testid="selection-summary-count"
            >
                <span className="text-2xl font-semibold tabular-nums text-content-emphasis">
                    {count}
                </span>
                <span className="text-sm text-content-muted">
                    {t('countLabel', { word })}
                </span>
            </p>

            {actions.length > 0 && (
                <div className="space-y-tight">
                    {actions.map((action) => (
                        <Button
                            key={action.label}
                            type="button"
                            variant={
                                action.tone === 'danger'
                                    ? 'destructive'
                                    : 'secondary'
                            }
                            size="sm"
                            icon={action.icon}
                            className="w-full justify-start"
                            onClick={action.onClick}
                        >
                            {action.label}
                        </Button>
                    ))}
                </div>
            )}

            <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-start text-content-muted"
                onClick={onClear}
            >
                {t('clearSelection')}
            </Button>
        </div>
    );
}
