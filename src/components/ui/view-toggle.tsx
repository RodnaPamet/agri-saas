'use client';

/**
 * Epic 66 — `<ViewToggle>` segmented practice.
 *
 * Two-option Table/Cards switch designed to drop into the
 * `FilterToolbar`'s `actions` slot. Built on the existing
 * `<ToggleGroup>` so it inherits the keyboard radiogroup contract,
 * focus ring, and motion-pill behaviour without re-implementing.
 *
 * Pages adopt the toggle in three lines:
 *
 *   const [view, setView] = useViewMode('practices');
 *   <FilterToolbar
 *     actions={<ViewToggle view={view} onChange={setView} />}
 *   />
 *   {view === 'table' ? <DataTable … /> : <CardList … />}
 *
 * Filter / search / query state stays unchanged — `view` is a
 * presentation concern, not a data concern. Switching does not
 * remount the filter context or refetch the underlying query.
 */

import { LayoutGrid, Table } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { ToggleGroup } from '@/components/ui/toggle-group';
import type { ViewMode } from '@/components/ui/hooks/use-view-mode';

export interface ViewToggleProps {
    /** Currently-selected view. */
    view: ViewMode;
    /** Called when the user picks a different view. */
    onChange: (next: ViewMode) => void;
    /** Override the radiogroup's accessible label. Defaults to "View mode". */
    ariaLabel?: string;
    /** Optional class on the wrapper. */
    className?: string;
    /**
     * Size variant — defaults to `sm` since the toggle lives in a
     * dense filter toolbar. Pass `default` for primary-surface
     * placements (empty state, dashboards).
     */
    size?: 'sm' | 'default';
    /** Optional `data-testid` on the wrapper. */
    'data-testid'?: string;
}

export function ViewToggle({
    view,
    onChange,
    ariaLabel: ariaLabelProp,
    className,
    size = 'sm',
    'data-testid': testId,
}: ViewToggleProps) {
    const t = useTranslations('ui.viewToggle');
    const ariaLabel = ariaLabelProp ?? t('viewMode');
    return (
        <div data-view-toggle data-view={view} data-testid={testId}>
            <ToggleGroup
                size={size}
                ariaLabel={ariaLabel}
                selected={view}
                selectAction={(value) => onChange(value as ViewMode)}
                className={className}
                options={[
                    {
                        value: 'table',
                        id: 'view-toggle-table',
                        label: (
                            <span className="flex items-center gap-1.5">
                                <Table
                                    className="size-3.5"
                                    aria-hidden="true"
                                />
                                <span>{t('table')}</span>
                            </span>
                        ),
                    },
                    {
                        value: 'cards',
                        id: 'view-toggle-cards',
                        label: (
                            <span className="flex items-center gap-1.5">
                                <LayoutGrid
                                    className="size-3.5"
                                    aria-hidden="true"
                                />
                                <span>{t('cards')}</span>
                            </span>
                        ),
                    },
                ]}
            />
        </div>
    );
}

export default ViewToggle;
