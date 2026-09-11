'use client';

/**
 * ChecklistGearButton — the shared gear-popover checklist primitive
 * (2026-06-07).
 *
 * Both toolbar gears render through this ONE component: the "Edit filter
 * cards" gear (icon `Settings`, via `EditFiltersButton`) and the "Toggle
 * columns" gear (icon `Columns3`, via `EditColumnsButton`). The checklist
 * row recipe, the numbered click-to-order badges, the cmdk keyboard nav,
 * the scroll container, the ring indicator, and the reset row all live
 * here — zero duplication. The two wrappers only bind their domain icon /
 * title / test-id and map their definitions into `items`.
 *
 * Ordering is the click-to-order model from `checklist-order.ts`: visible
 * rows carry a 1-based number badge (their left-to-right position); hidden
 * rows sort below with no number. Selecting a row calls `onToggle(id)` —
 * the owning hook appends/removes the id and renumbers.
 *
 * The hover hint is the canonical `<Tooltip>`, wired via the Popover's
 * `triggerTooltip` prop. The Popover nests it as Tooltip OUTER → Popover.Trigger
 * INNER → button, so the inner Trigger's asChild Slot keeps the popover-open
 * click on the button while the tooltip hover merges through it. This replaced
 * the old native `title=` workaround (the reverse nesting swallowed the click —
 * the "gear doesn't open" bug). `aria-label` gives the SR name.
 */
import { Command } from 'cmdk';
import { GripVertical, RotateCcw } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from './button';
import { Popover } from './popover';
import { ScrollContainer } from './scroll-container';
import { cn } from '@/lib/cn';
import type { ChecklistGearItem } from './checklist-order';

export interface ChecklistGearButtonProps {
    /** Rows in DISPLAY order: visible (numbered) first, then hidden. */
    items: ChecklistGearItem[];
    /** Toggle a row's visibility (append/remove in the owning hook). */
    onToggle: (id: string) => void;
    /** Restore defaults. Omit to hide the reset row. */
    onReset?: () => void;
    /**
     * Drag-to-reorder a visible row to another visible row's position.
     * When provided, visible rows show a drag handle. Click-to-order still
     * works — drag is the complementary "move anywhere" gesture.
     */
    onReorder?: (fromId: string, toId: string) => void;
    /** Ring indicator — true when modified from default (hidden or reordered). */
    someModified: boolean;
    /** Hover hint + accessible name (e.g. "Edit filter cards"). */
    title: string;
    /** The gear icon — `Settings` (filters) or `Columns3` (columns). */
    icon: ReactNode;
    /** Stable id for E2E (e.g. "edit-filters-button"). */
    'data-testid': string;
    className?: string;
    id?: string;
}

export function ChecklistGearButton({
    items,
    onToggle,
    onReset,
    onReorder,
    someModified,
    title,
    icon,
    'data-testid': testId,
    className,
    id,
}: ChecklistGearButtonProps) {
    const t = useTranslations('ui');
    const [open, setOpen] = useState(false);
    // The id being dragged (handle → drop target). A ref, not state — it
    // mutates across native drag events without needing a re-render.
    const dragId = useRef<string | null>(null);

    const reset = () => {
        onReset?.();
        setOpen(false);
    };

    return (
        <Popover
            openPopover={open}
            setOpenPopover={setOpen}
            triggerTooltip={title}
            align="end"
            content={
                <ScrollContainer className="max-h-[50svh]">
                    <Command tabIndex={0} loop>
                        <Command.List className="flex w-screen flex-col gap-0.5 p-1 text-sm focus-visible:outline-none sm:w-auto sm:min-w-[200px]">
                            {items.map((item) => (
                                <Command.Item
                                    key={item.id}
                                    // Explicit, stable value — without it cmdk
                                    // derives the value from the row's rendered
                                    // text, which INCLUDES the order-badge
                                    // number. When toggling changes a row's
                                    // number its derived value churns, leaving
                                    // some rows (e.g. a default-hidden one like
                                    // "Frequency") unselectable. The id is
                                    // stable + unique.
                                    value={item.id}
                                    className={cn(
                                        'flex cursor-pointer select-none items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-1.5',
                                        'text-content-default hover:text-content-emphasis',
                                        'data-[selected=true]:bg-bg-muted',
                                    )}
                                    onSelect={() => onToggle(item.id)}
                                    data-testid={`checklist-toggle-${item.id}`}
                                    onDragOver={
                                        onReorder && item.visible
                                            ? (e) => e.preventDefault()
                                            : undefined
                                    }
                                    onDrop={
                                        onReorder && item.visible
                                            ? (e) => {
                                                  e.preventDefault();
                                                  const from = dragId.current;
                                                  if (from && from !== item.id) {
                                                      onReorder(from, item.id);
                                                  }
                                                  dragId.current = null;
                                              }
                                            : undefined
                                    }
                                >
                                    {/* Drag handle (visible rows) — reorder a
                                        card/column anywhere. A SEPARATE gesture
                                        from the row click (toggle), so the two
                                        don't fight; `stopPropagation` on
                                        pointer-down keeps cmdk from selecting
                                        the row when you grab the handle. */}
                                    {onReorder && item.visible && (
                                        <span
                                            draggable
                                            onDragStart={(e) => {
                                                dragId.current = item.id;
                                                e.dataTransfer.effectAllowed =
                                                    'move';
                                            }}
                                            onDragEnd={() => {
                                                dragId.current = null;
                                            }}
                                            onPointerDown={(e) =>
                                                e.stopPropagation()
                                            }
                                            className="flex h-4 w-3 shrink-0 cursor-grab items-center justify-center text-content-subtle [&_svg]:h-3.5 [&_svg]:w-3.5"
                                            data-testid={`checklist-drag-${item.id}`}
                                            aria-hidden="true"
                                        >
                                            <GripVertical />
                                        </span>
                                    )}
                                    {/* Order badge — the 1-based position
                                        (= left-to-right order); blank when
                                        hidden. */}
                                    <span
                                        className={cn(
                                            'flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-semibold tabular-nums',
                                            item.visible
                                                ? 'bg-[var(--brand-subtle)] text-[var(--brand-default)]'
                                                : 'text-content-subtle',
                                        )}
                                        data-testid={`checklist-order-${item.id}`}
                                    >
                                        {item.order ?? ''}
                                    </span>
                                    {/* Visibility checkbox */}
                                    <div
                                        className={cn(
                                            'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                                            item.visible
                                                ? 'border-[var(--brand-default)] bg-[var(--brand-emphasis)] text-content-inverted'
                                                : 'border-border-default bg-transparent',
                                        )}
                                    >
                                        {item.visible && (
                                            <svg
                                                className="h-3 w-3"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                strokeWidth={3}
                                            >
                                                <path
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    d="M5 13l4 4L19 7"
                                                />
                                            </svg>
                                        )}
                                    </div>
                                    {item.icon && (
                                        <span className="shrink-0 text-content-muted [&_svg]:h-3.5 [&_svg]:w-3.5">
                                            {item.icon}
                                        </span>
                                    )}
                                    <span className="truncate">{item.label}</span>
                                </Command.Item>
                            ))}

                            {onReset && someModified && (
                                <>
                                    <div className="my-1 h-px bg-border-subtle" />
                                    <Command.Item
                                        className={cn(
                                            'flex cursor-pointer select-none items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-1.5',
                                            'text-content-muted hover:text-content-default',
                                            'data-[selected=true]:bg-bg-muted',
                                        )}
                                        onSelect={reset}
                                        data-testid="checklist-reset"
                                    >
                                        <RotateCcw className="h-3.5 w-3.5 shrink-0" />
                                        <span>{t('checklistGearButton.resetToDefaults')}</span>
                                    </Command.Item>
                                </>
                            )}
                        </Command.List>
                    </Command>
                </ScrollContainer>
            }
        >
            <Button
                type="button"
                className={cn(
                    'size-9 shrink-0 whitespace-nowrap rounded-[8px] p-0',
                    someModified && 'ring-1 ring-[var(--brand-default)]/30',
                    className,
                )}
                variant="secondary"
                icon={icon}
                aria-label={title}
                data-testid={testId}
                id={id}
            />
        </Popover>
    );
}
