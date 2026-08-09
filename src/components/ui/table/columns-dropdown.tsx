"use client";

/**
 * ColumnsDropdown — the "Toggle columns" gear (2026-06-07 rewrite).
 *
 * Now a thin wrapper over the shared `<ChecklistGearButton>` (the same
 * primitive the "Edit filter cards" gear uses). It binds the COLUMN
 * domain: the `Columns3` icon (distinct from the filter gear's `Settings`
 * so the two adjacent gears are tellable apart at a glance), the "Toggle
 * columns" title, and the `toggle-columns-button` test-id. All checklist /
 * numbered click-to-order / ring / reset behaviour lives in the shared
 * primitive; `useColumnsDropdown` owns the order+visibility state and maps
 * it into `items`.
 *
 * Sits SECOND (right) in the toolbar actions slot — it practices the table
 * below, secondary to the filter gear.
 */

import { useTranslations } from "next-intl";
import { Columns3 } from "lucide-react";
import { ChecklistGearButton } from "../checklist-gear-button";
import type { ChecklistGearItem } from "../checklist-order";

export interface ColumnsDropdownProps {
    /** Rows in display order (visible numbered, then hidden). */
    items: ChecklistGearItem[];
    onToggle: (id: string) => void;
    onReset?: () => void;
    onReorder?: (fromId: string, toId: string) => void;
    someModified: boolean;
    className?: string;
    id?: string;
}

export function ColumnsDropdown({
    items,
    onToggle,
    onReset,
    onReorder,
    someModified,
    className,
    id,
}: ColumnsDropdownProps) {
    const t = useTranslations("filtersChrome");
    return (
        <ChecklistGearButton
            items={items}
            onToggle={onToggle}
            onReset={onReset}
            onReorder={onReorder}
            someModified={someModified}
            icon={<Columns3 className="h-4 w-4 shrink-0" />}
            title={t("toggleColumns")}
            data-testid="toggle-columns-button"
            className={className}
            id={id}
        />
    );
}
