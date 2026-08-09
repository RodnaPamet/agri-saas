/**
 * Epic 58 — shared date-picker Trigger.
 *
 * Token-backed button that opens a date picker popover or sheet.
 * Visually consistent with the filter-select trigger shipped in
 * Epic 57 so every list-page toolbar reads with the same vocabulary
 * — calendar icon on the left, displayed value (or placeholder)
 * in the middle, chevron on the right.
 *
 * Composition:
 *   - Fully forwards its ref and props, so Radix Popover and Vaul
 *     Drawer's `asChild` trigger pattern both work — the wrapper
 *     clones this button and attaches `data-state`,
 *     `aria-expanded`, `aria-haspopup`, `onClick`, and the anchor
 *     ref in one go.
 *   - `placeholder` renders in `text-content-subtle` whenever no
 *     `children` value is supplied. Callers pass the formatted
 *     selection (via `formatDate`/`formatDateRange`) as `children`.
 *
 * Token states:
 *   - Default: `bg-bg-default` surface, `border-border-default` edge,
 *     `text-content-emphasis` value.
 *   - Open (`data-state="open"`): `border-border-emphasis` +
 *     `ring-4 ring-ring` — identical to filter-select's emphasized
 *     focus ring.
 *   - Error (`hasError`): red border + ring drawn from the
 *     `border-error` / `ring-error` tokens, with aria-invalid so
 *     form validators pick it up.
 *   - Disabled: muted surface, no pointer events.
 */

import { cn } from '@/lib/cn';
import { cva, type VariantProps } from 'class-variance-authority';
import { Calendar as CalendarIcon, ChevronDown } from 'lucide-react';
import { forwardRef, type ComponentProps } from 'react';

// R20-PR-B — date-picker trigger migrated to the R20 practice-parity
// edge tokens. The rest/hover/focus channels now ride
// `--ctrl-edge-rest` / `--ctrl-edge-hover` / `--ctrl-edge-focus` so
// a focused date-picker trigger feels like a cousin of a focused
// Input and a focused Button — three practices, one focus
// vocabulary. The Tailwind ring is dropped in favour of a
// brand-tinted box-shadow halo so the open state can layer cleanly
// (R20 doesn't widen open-state styling here; that's a later
// roadmap if we go to "iridescent OPEN trigger" territory).
const triggerStyles = cva(
    [
        // R22-PR-A — radius mirror of button-variants.ts (12→10px).
        'group peer flex h-10 appearance-none items-center gap-x-2 truncate rounded-[8px] px-3 text-sm outline-none',
        'transition-[color,border-color,box-shadow] duration-150 ease-out motion-reduce:transition-none',
        'border border-[var(--ctrl-edge-rest)] bg-bg-default text-content-emphasis',
        'hover:border-[var(--ctrl-edge-hover)]',
        'cursor-pointer disabled:cursor-not-allowed',
        'focus-visible:shadow-[var(--ctrl-edge-focus)]',
        'data-[state=open]:border-[var(--ctrl-edge-hover)] data-[state=open]:shadow-[var(--ctrl-edge-focus)]',
        'active:scale-[0.99] motion-reduce:active:scale-100',
        'disabled:bg-bg-muted disabled:text-content-subtle disabled:border-[var(--ctrl-edge-rest)]',
    ],
    {
        variants: {
            hasError: {
                true: 'border-border-error shadow-[0_0_0_3px_rgb(220_38_38_/_0.20)] data-[state=open]:border-border-error',
            },
        },
    },
);

export interface TriggerProps
    extends ComponentProps<'button'>,
        VariantProps<typeof triggerStyles> {
    /** Shown in the value slot when no `children` are supplied. */
    placeholder?: string;
    /** Accessible label when there is no visible value. */
    'aria-label'?: string;
}

const Trigger = forwardRef<HTMLButtonElement, TriggerProps>(
    (
        {
            className,
            children,
            placeholder,
            hasError,
            disabled,
            type,
            'aria-invalid': ariaInvalid,
            ...props
        },
        forwardedRef,
    ) => {
        return (
            // eslint-disable-next-line jsx-a11y/role-supports-aria-props -- aria-invalid IS valid on <button> per WAI-ARIA 1.1 (global state); the lint rule's role-spec table is overly strict here. The form-trigger UX requires the invalid state to be announced.
            <button
                ref={forwardedRef}
                // Default to `type="button"` so the trigger never
                // accidentally submits the surrounding form.
                type={type ?? 'button'}
                className={cn(triggerStyles({ hasError }), className)}
                disabled={disabled}
                data-date-picker-trigger
                aria-invalid={hasError ? true : ariaInvalid}
                aria-haspopup="dialog"
                {...props}
            >
                <CalendarIcon
                    aria-hidden="true"
                    className="size-4 shrink-0 text-content-muted group-hover:text-content-default"
                />
                <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left">
                    {children ? (
                        <span
                            className="text-content-emphasis"
                            data-testid="date-picker-trigger-value"
                        >
                            {children}
                        </span>
                    ) : placeholder ? (
                        <span
                            className="text-content-subtle"
                            data-testid="date-picker-trigger-placeholder"
                        >
                            {placeholder}
                        </span>
                    ) : null}
                </span>
                <ChevronDown
                    aria-hidden="true"
                    className="size-4 shrink-0 text-content-subtle transition-transform duration-100 ease-out group-data-[state=open]:rotate-180 motion-reduce:transition-none"
                />
            </button>
        );
    },
);

Trigger.displayName = 'DatePicker.Trigger';

export { Trigger };
