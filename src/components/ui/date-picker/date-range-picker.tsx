'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/* eslint-disable react-hooks/exhaustive-deps -- Various useMemo dep arrays in this file deliberately omit identity-unstable callbacks (handlers/derived arrays recreated each render). The proper structural fix is wrapping parent-level callbacks in useCallback. Tracked as follow-up; existing per-line eslint-disable-next-line markers preserved. */
/**
 * Epic 58 — canonical date-range picker.
 *
 * The workhorse for reporting filters, evidence-retention windows,
 * audit cycles, and any UI that asks the user for a "from / to"
 * date window. Composes the Epic 58 foundation:
 *
 *   - `<Trigger>` token-backed opener.
 *   - `<Popover>` (Radix on desktop, Vaul on mobile via
 *     `useMediaQuery`) for the dropdown surface.
 *   - `<Calendar>` in `mode="range"`, one month on mobile and two
 *     side-by-side on desktop so users can scan windows spanning
 *     month boundaries without paging.
 *   - `<Presets>` panel on the left for common reporting ranges,
 *     optional (pass `presets={undefined}` for a pure calendar).
 *
 * Domain types:
 *   - `value` / `defaultValue` / `onChange` all trade in
 *     `DateRangeValue` (null-biased). react-day-picker's
 *     undefined-biased `DateRange` stays internal.
 *   - `presets` accepts `ResolvableDateRangePreset[]` (the
 *     catalogue's natural shape) and materialises them at open time
 *     against the current `now`, so a preset resolves to the same
 *     boundaries whether the user opens the picker at 01:30 or 23:45.
 *
 * Interaction:
 *   - Clicking a day sets the "from" bound. Clicking a second day
 *     sets the "to" bound and commits via `onChange` + close.
 *   - Clicking a preset commits its range and closes. The keyboard
 *     shortcut on a preset (e.g. "l" for "Last 30 days") also works
 *     while the popover is open — wired through the Epic 57 shared
 *     keyboard-shortcut system with `scope: 'overlay'`.
 *   - Closing the popover without a second click discards the
 *     in-progress selection (matches the vendored behaviour).
 *   - `clearable` adds a Clear button in the footer that emits
 *     `onChange({ from: null, to: null })`.
 */

import { cn } from '@/lib/cn';
import { enUS } from 'date-fns/locale';
import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
    useCallback,
    useEffect,
    useMemo,
    useState,
} from 'react';
import type { DateRange as RDPDateRange } from 'react-day-picker';

import { useDateFormat } from '@/lib/i18n/use-date-format';

import { useKeyboardShortcut, useMediaQuery } from '../hooks';
import { Popover } from '../popover';
import { Calendar as CalendarPrimitive } from './calendar';
import {
    fromDateRangeValue,
    isRangeEqual,
    materializeDateRangePreset,
    normalizeRange,
    toDateRangeValue,
    toRangeToken,
} from './date-utils';
import { Presets } from './presets';
import { DatePickerContext } from './shared';
import { Trigger } from './trigger';
import type {
    ControlledDateRangeProps,
    DateRangePreset,
    DateRangeValue,
    PickerProps,
    ResolvableDateRangePreset,
} from './types';

export interface DateRangePickerProps
    extends ControlledDateRangeProps,
        PickerProps {
    /**
     * Resolvable preset list. Materialised at popover open time
     * against `new Date()` so presets always reflect the current
     * wall-clock "now".
     */
    presets?: ResolvableDateRangePreset[];
    /** Highlight the preset matching this id (overrides value match). */
    presetId?: string;
    /**
     * When true, the picker footer renders a Clear button that
     * emits `{ from: null, to: null }` and closes. Defaults to
     * `true` — range pickers are usually optional filters.
     */
    clearable?: boolean;
    /**
     * Fires on every committed selection (day pair or preset).
     * The optional `context.preset` is the resolvable preset the
     * user picked, when the commit originated from the preset panel.
     */
    onChange?: (
        next: DateRangeValue,
        context?: { preset?: ResolvableDateRangePreset },
    ) => void;
}

function rangeIsComplete(range: RDPDateRange | undefined): range is { from: Date; to: Date } {
    return Boolean(range && range.from && range.to);
}

export function DateRangePicker({
    value,
    defaultValue,
    onChange,
    presets,
    presetId,
    disabled,
    disabledDays,
    showYearNavigation = false,
    locale = enUS,
    placeholder,
    hasError,
    align = 'center',
    className,
    clearable = true,
    ...props
}: DateRangePickerProps) {
    const { formatDateRange } = useDateFormat();
    const t = useTranslations('ui');
    const resolvedPlaceholder = placeholder ?? t('datePicker.selectDateRange');
    const { isDesktop } = useMediaQuery();

    const isControlled = value !== undefined;
    const [internal, setInternal] = useState<DateRangeValue>(
        isControlled
            ? (value as DateRangeValue)
            : defaultValue ?? { from: null, to: null },
    );
    const committed: DateRangeValue = isControlled
        ? (value as DateRangeValue)
        : internal;

    // In-progress selection lives in `draft` while the popover is
    // open. We only commit via `onChange` once the user places the
    // second bound or picks a preset.
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<RDPDateRange | undefined>(
        fromDateRangeValue(committed),
    );
    const [month, setMonth] = useState<Date | undefined>(
        committed.to ?? committed.from ?? undefined,
    );

    // Keep internal mirror in sync when controlled.
    useEffect(() => {
        if (isControlled) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setInternal((value as DateRangeValue) ?? { from: null, to: null });
        }
    }, [isControlled, value]);

    // When the popover opens, seed the draft from the committed
    // value. When it closes without completion, discard the draft.
    useEffect(() => {
        if (open) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setDraft(fromDateRangeValue(committed));
            setMonth(committed.to ?? committed.from ?? new Date());
        } else {
            setDraft(fromDateRangeValue(committed));
        }

    }, [open]);

    // Materialise resolvable presets once per open cycle. Using a
    // ref for "now" keeps the boundaries stable while the popover is
    // open — otherwise "Today" could change definition at midnight
    // while the user is mid-selection.
    const openNow = useMemo(() => new Date(), [open]);
    const materialisedPresets = useMemo<DateRangePreset[]>(() => {
        if (!presets) return [];
        return presets.map((p) => materializeDateRangePreset(p, openNow));
    }, [presets, openNow]);

    // Determine which preset (if any) the committed range matches so
    // the Presets panel highlights it.
    const activePresetId = useMemo(() => {
        if (presetId) return presetId;
        if (!presets || !committed.from || !committed.to) return undefined;
        for (const p of presets) {
            const resolved = p.resolve(openNow);
            if (isRangeEqual(resolved, committed)) return p.id;
        }
        return undefined;
    }, [presetId, presets, committed, openNow]);

    const commit = useCallback(
        (next: DateRangeValue, preset?: ResolvableDateRangePreset) => {
            const normalized = normalizeRange(next);
            if (!isControlled) setInternal(normalized);
            onChange?.(normalized, preset ? { preset } : undefined);
            setOpen(false);
        },
        [isControlled, onChange],
    );

    const handleCalendarSelect = useCallback(
        (_nextRDP: RDPDateRange | undefined, clickedDay: Date) => {
            // Don't trust react-day-picker's range inference across
            // clicks — it varies between v8/v9 and doesn't surface
            // the same shape under jsdom. Drive the range from the
            // click count ourselves:
            //
            //   - No draft / closed draft → start a new range
            //     anchored at the clicked day (`from=day, to=undef`).
            //   - Draft has `from` but no `to` → close it; the later
            //     click becomes the `to` bound (swap if before from).
            const draftComplete = rangeIsComplete(draft);
            const hasOnlyFrom = Boolean(draft?.from && !draft.to);
            let workingRange: RDPDateRange;
            if (hasOnlyFrom && draft?.from) {
                const from = draft.from;
                workingRange =
                    clickedDay.getTime() < from.getTime()
                        ? { from: clickedDay, to: from }
                        : { from, to: clickedDay };
            } else if (draftComplete) {
                workingRange = { from: clickedDay, to: undefined };
            } else {
                workingRange = { from: clickedDay, to: undefined };
            }

            setDraft(workingRange);

            if (rangeIsComplete(workingRange)) {
                commit(toDateRangeValue(workingRange));
            }
        },
        [draft, commit],
    );

    const handlePresetSelect = useCallback(
        (preset: DateRangePreset) => {
            const resolvable = presets?.find((p) => p.id === preset.id);
            if (!resolvable) return;
            commit(resolvable.resolve(new Date()), resolvable);
        },
        [presets, commit],
    );

    const handleClear = useCallback(() => {
        commit({ from: null, to: null });
    }, [commit]);

    // Keyboard shortcuts for preset rows — scoped to the overlay.
    useKeyboardShortcut(
        (presets?.filter((p) => p.shortcut).map((p) => p.shortcut) as string[]) ??
            [],
        (e: KeyboardEvent) => {
            const p = presets?.find((preset) => preset.shortcut === e.key);
            if (p) commit(p.resolve(new Date()), p);
        },
        {
            enabled: open,
            scope: 'overlay',
            priority: 5,
            description: 'Apply date-range preset',
        },
    );

    // Trigger display text. Prefer the active preset label (stable,
    // reads better than a 30-day span); fall back to the canonical
    // `formatDateRange()` so every range across the app — picker
    // triggers, filter pills, audit cycles, reports legends — reads
    // in the same dialect.
    const displayText = useMemo(() => {
        if (activePresetId) {
            const p = presets?.find((pr) => pr.id === activePresetId);
            if (p) return p.label;
        }
        if (!committed.from && !committed.to) return null;
        return formatDateRange(committed.from, committed.to, '');
    }, [activePresetId, presets, committed]);

    return (
        <DatePickerContext.Provider
            value={{ isOpen: open, setIsOpen: setOpen }}
        >
            <Popover
                align={align}
                openPopover={open}
                setOpenPopover={setOpen}
                popoverContentClassName="rounded-xl overflow-hidden"
                content={
                    <div className="flex w-full flex-col bg-bg-default">
                        <div
                            className={cn(
                                'relative flex w-full',
                                'flex-col sm:flex-row-reverse sm:items-start',
                            )}
                        >
                            <div className="min-w-0 flex-1">
                                <CalendarPrimitive
                                    mode="range"
                                    selected={draft}
                                    onSelect={handleCalendarSelect}
                                    month={month}
                                    onMonthChange={setMonth}
                                    numberOfMonths={isDesktop ? 2 : 1}
                                    disabled={disabledDays}
                                    showYearNavigation={showYearNavigation}
                                    locale={locale}
                                    classNames={{
                                        months:
                                            'flex flex-row divide-x divide-border-subtle',
                                    }}
                                    {...props}
                                />
                            </div>
                            {materialisedPresets.length > 0 && (
                                <div
                                    className={cn(
                                        'w-full shrink-0 border-b border-border-subtle',
                                        'sm:w-48 sm:border-b-0 sm:border-r',
                                        'sm:max-h-[20rem] sm:overflow-y-auto',
                                        'py-1',
                                    )}
                                >
                                    <Presets
                                        presets={materialisedPresets}
                                        onSelect={handlePresetSelect}
                                        activePresetId={activePresetId}
                                    />
                                </div>
                            )}
                        </div>
                        {clearable && (committed.from || committed.to) && (
                            <div className="flex items-center justify-end border-t border-border-subtle px-2 py-1.5">
                                <button
                                    type="button"
                                    onClick={handleClear}
                                    className={cn(
                                        'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs',
                                        'text-content-muted transition-colors',
                                        'hover:bg-bg-muted hover:text-content-emphasis',
                                    )}
                                    data-testid="date-range-picker-clear"
                                >
                                    <X className="size-3.5" aria-hidden="true" />
                                    <span>{t('datePicker.clearRange')}</span>
                                </button>
                            </div>
                        )}
                    </div>
                }
            >
                <Trigger
                    placeholder={resolvedPlaceholder}
                    disabled={disabled}
                    className={className}
                    hasError={hasError}
                    aria-required={props.required || props['aria-required']}
                    aria-invalid={props['aria-invalid']}
                    aria-label={props['aria-label']}
                    aria-labelledby={props['aria-labelledby']}
                    data-value={toRangeToken(committed)}
                >
                    {displayText}
                </Trigger>
            </Popover>
        </DatePickerContext.Provider>
    );
}
