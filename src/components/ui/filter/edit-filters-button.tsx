'use client';

/**
 * EditFiltersButton — the "Edit filter cards" gear (2026-06-07).
 *
 * Thin wrapper over the shared `<ChecklistGearButton>`: binds the filter
 * domain's icon (`Settings`), title, and test-id; all checklist / ordering
 * / ring / reset behaviour lives in the shared primitive. The companion
 * `useFilterCardVisibility` hook owns the state and renders this.
 *
 * Sits FIRST (leftmost) in the toolbar's actions slot — it practices the
 * primary toolbar content. The columns gear (`Columns3`) sits second.
 */
import { useTranslations } from 'next-intl';
import { Settings } from 'lucide-react';
import { ChecklistGearButton } from '@/components/ui/checklist-gear-button';
import type { ChecklistGearItem } from '@/components/ui/checklist-order';

export interface EditFiltersButtonProps {
    items: ChecklistGearItem[];
    onToggle: (id: string) => void;
    onReset?: () => void;
    onReorder?: (fromId: string, toId: string) => void;
    someModified: boolean;
    className?: string;
    id?: string;
}

export function EditFiltersButton(props: EditFiltersButtonProps) {
    const t = useTranslations('filtersChrome');
    return (
        <ChecklistGearButton
            {...props}
            icon={<Settings className="h-4 w-4 shrink-0" />}
            title={t('editFilterCards')}
            data-testid="edit-filters-button"
        />
    );
}
