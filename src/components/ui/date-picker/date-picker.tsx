'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/**
 * Epic 58 — canonical single-date picker.
 *
 * Composes the Epic 58 foundation:
 *   - `<Trigger>` — token-backed opener, placeholder + value slot.
 *   - `<Popover>` — same responsive popover/vaul primitive that
 *     powers the filter system.
 *   - `<Calendar>` — token-backed react-day-picker surface.
 *
 * API contract:
 *   - Values are `DateValue = Date | null`. `null` means "no
 *     selection"; the trigger shows the placeholder.
 *   - Controlled (`value`) and uncontrolled (`defaultValue`) patterns
 *     both supported — identical to a native input.
 *   - `onChange(next)` is called with the selected Date or `null`
 *     when the user clears. Popover closes on both paths.
 *   - Display rendering goes through `@/lib/format-date` so a picker
 *     on one route reads identically to a date printed anywhere else
 *     in the app.
 *
 * Not-goals for this picker:
 *   - Time selection. Evidence expiry and policy review are
 *     day-level by design; a time-aware variant can layer on later.
 *   - Presets. Single-date presets are rare in product (you don't
 *     "pick Today" from a date field). The range picker is where
 *     presets pay their keep.
 */

import { cn } from '@/lib/cn';
import { enUS } from 'date-fns/locale';
import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
    useCallback,
    useEffect,
    useState,
    type ReactElement,
} from 'react';

import { useDateFormat } from '@/lib/i18n/use-date-format';

import { Popover } from '../popover';
import { Calendar as CalendarPrimitive } from './calendar';
import { toYMD } from './date-utils';
import { DatePickerContext } from './shared';
import { Trigger } from './trigger';
import type {
    ControlledDateValueProps,
    DateValue,
    PickerProps,
} from './types';

export interface DatePickerTriggerRenderProps {
    displayValue: string | null;
    placeholder: string;
    open: boolean;
    disabled?: boolean;
    invalid?: boolean;
}

export interface DatePickerProps
    extends ControlledDateValueProps,
        PickerProps {
    /**
     * Custom trigger element. Useful when the surrounding form wraps
     * the field in its own label / helper / error layout and doesn't
     * want the built-in Trigger aesthetic. Must return a single
     * React element so the popover can attach the anchor ref.
     */
    trigger?: (props: DatePickerTriggerRenderProps) => ReactElement;
    /**
     * When true, render a "Clear" row below the calendar and fire
     * `onChange(null)` on click. Defaults to `false` because required
     * form fields shouldn't invite a user to empty them.
     */
    clearable?: boolean;
    /** Mirror of `hasError` for call sites that prefer the a11y name. */
    invalid?: boolean;
}

/**
 * Convert our nullable `DateValue` (UTC-midnight Date per the
 * date-utils contract) to the `Date | undefined` shape
 * react-day-picker's `mode="single"` prop wants.
 *
 * RDP works in LOCAL time — it derives the highlighted day from
 * the input Date's local Y/M/D. If we pass a UTC-midnight Date
 * (`2026-05-24T00:00Z`) to a UTC-4 user, RDP would read local
 * components and see "2026-05-23 20:00" → highlight the 23rd
 * instead of the 24th. The selection symptom is the same in
 * reverse: a click on the 24th would round-trip back to the 23rd
 * once `toYMD` reads UTC components.
 *
 * Re-anchor: build a LOCAL midnight whose Y/M/D matches the input's
 * UTC Y/M/D. RDP then shows the correct day, and the matching
 * `fromRDPSingle` reverses the bridge.
 */
function toRDPSingle(v: DateValue): Date | undefined {
    if (!v) return undefined;
    return new Date(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate());
}

/**
 * Inverse of {@link toRDPSingle}. React-day-picker emits a
 * LOCAL-midnight Date for a clicked day; rebuild a UTC-midnight
 * Date with the SAME calendar Y/M/D so downstream callers reading
 * `getUTCDate()` see the day the user clicked.
 */
function fromRDPSingle(local: Date | undefined): DateValue {
    if (!local) return null;
    return new Date(
        Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()),
    );
}

export function DatePicker({
    value,
    defaultValue,
    onChange,
    trigger: customTrigger,
    disabled,
    disabledDays,
    showYearNavigation = false,
    locale = enUS,
    placeholder,
    hasError,
    invalid,
    align = 'center',
    className,
    clearable = false,
    ...props
}: DatePickerProps) {
    const { formatDate } = useDateFormat();
    const t = useTranslations('ui');
    const resolvedPlaceholder = placeholder ?? t('datePicker.selectDate');
    const [open, setOpen] = useState(false);
    const isControlled = value !== undefined;
    const [internal, setInternal] = useState<DateValue>(
        isControlled ? (value as DateValue) : (defaultValue ?? null),
    );
    const selected: DateValue = isControlled ? (value as DateValue) : internal;

    // Keep internal mirror of a controlled value so uncontrolled
    // re-renders don't clobber it mid-selection.
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (isControlled) setInternal((value as DateValue) ?? null);
    }, [isControlled, value]);

    const handleSelect = useCallback(
        (next: Date | undefined) => {
            // RDP gives us local-midnight; rebridge to UTC-midnight
            // so downstream `toYMD(getUTCDate(...))` reads the day
            // the user clicked, not the off-by-one in negative tz.
            const nextValue: DateValue = fromRDPSingle(next);
            if (!isControlled) setInternal(nextValue);
            onChange?.(nextValue);
            setOpen(false);
        },
        [isControlled, onChange],
    );

    const handleClear = useCallback(() => {
        if (!isControlled) setInternal(null);
        onChange?.(null);
        setOpen(false);
    }, [isControlled, onChange]);

    // Display text. Deliberately uses the app's canonical formatter
    // so a date in the picker reads identically to the same date
    // printed in a table cell or detail page.
    const displayValue =
        selected && !Number.isNaN(selected.getTime())
            ? formatDate(selected)
            : null;

    return (
        <DatePickerContext.Provider value={{ isOpen: open, setIsOpen: setOpen }}>
            <Popover
                align={align}
                openPopover={open}
                setOpenPopover={setOpen}
                popoverContentClassName="rounded-xl overflow-hidden"
                content={
                    <div className="flex w-full flex-col bg-bg-default">
                        <CalendarPrimitive
                            mode="single"
                            selected={toRDPSingle(selected)}
                            onSelect={handleSelect}
                            disabled={disabledDays}
                            showYearNavigation={showYearNavigation}
                            locale={locale}
                            {...props}
                        />
                        {clearable && selected && (
                            <button
                                type="button"
                                onClick={handleClear}
                                className={cn(
                                    'flex items-center justify-center gap-tight',
                                    'border-t border-border-subtle px-3 py-2 text-xs',
                                    'text-content-muted transition-colors',
                                    'hover:bg-bg-muted hover:text-content-emphasis',
                                )}
                                data-testid="date-picker-clear"
                            >
                                <X className="size-3.5" aria-hidden="true" />
                                <span>{t('datePicker.clear')}</span>
                            </button>
                        )}
                    </div>
                }
            >
                {customTrigger ? (
                    customTrigger({
                        displayValue,
                        placeholder: resolvedPlaceholder,
                        open,
                        disabled,
                        invalid: Boolean(hasError ?? invalid),
                    })
                ) : (
                    <Trigger
                        placeholder={resolvedPlaceholder}
                        disabled={disabled}
                        className={className}
                        hasError={Boolean(hasError ?? invalid)}
                        aria-required={props.required || props['aria-required']}
                        aria-invalid={props['aria-invalid']}
                        aria-label={props['aria-label']}
                        aria-labelledby={props['aria-labelledby']}
                        // Expose the YMD value for E2E tests and form
                        // introspection without leaking a Date object.
                        data-value={toYMD(selected) ?? undefined}
                    >
                        {displayValue}
                    </Trigger>
                )}
            </Popover>
        </DatePickerContext.Provider>
    );
}
