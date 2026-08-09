"use client";

/**
 * Epic 58 — shared Calendar primitive.
 *
 * A thin wrapper around `react-day-picker` v9 that applies the
 * Inflect token palette, a consistent navigation header, and
 * sensible defaults (single-mode by default, outside days shown
 * only for single-month layouts). The component is UI-pure — it
 * never owns selection state; consumers practice via `selected` +
 * `onSelect`, and the wider Single/Range picker wrappers drive
 * those props.
 *
 * Token-backed states:
 *   - Surface: `bg-bg-default`, border-free (the popover/dialog wraps it).
 *   - Day hover: `hover:bg-bg-muted` — same affordance as every
 *     hoverable row across the app (sidebar nav, filter chips).
 *   - Day focus-visible: `ring-2 ring-ring ring-offset-2` — matches
 *     `buttonVariants` so keyboard navigation feels native.
 *   - Selected day: `bg-brand-emphasis text-content-inverted`.
 *   - Range middle: `bg-brand-subtle text-content-emphasis`.
 *   - Disabled: muted + line-through, no hover response.
 *   - Today: semibold with a subtle outline so it reads even when
 *     another day is selected.
 *
 * Accessibility:
 *   - Month/year navigation buttons each carry an `aria-label` and
 *     a Tooltip with the same content, disabled when out of range.
 *   - `aria-live="polite"` on the heading announces month changes
 *     to screen readers without stealing focus.
 *   - `react-day-picker` already provides the roving-tabindex day
 *     grid; we preserve it by not overriding `components.Day`.
 */

import { cn } from '@/lib/cn';
import { addMonths, addYears, format } from 'date-fns';
import type { Locale as DateFnsLocale } from 'date-fns/locale';
import {
    ChevronLeft,
    ChevronRight,
    ChevronsLeft,
    ChevronsRight,
} from 'lucide-react';
import {
    forwardRef,
    useState,
    type ElementType,
    type HTMLAttributes,
} from 'react';
import { useTranslations } from 'next-intl';
import { DayPicker, type DayPickerProps } from 'react-day-picker';

import { Tooltip } from '../tooltip';

// ─── Navigation button (month + year arrows) ──────────────────────────

interface NavigationButtonProps extends HTMLAttributes<HTMLButtonElement> {
    onClick: () => void;
    icon: ElementType;
    disabled?: boolean;
}

const NavigationButton = forwardRef<HTMLButtonElement, NavigationButtonProps>(
    ({ onClick, icon: Icon, disabled, ...props }, forwardedRef) => {
        const label = props['aria-label'];
        const button = (
            <button
                ref={forwardedRef}
                type="button"
                disabled={disabled}
                className={cn(
                    'flex size-7 shrink-0 select-none items-center justify-center rounded-md border p-1',
                    'outline-none transition-colors duration-150',
                    'border-border-subtle text-content-muted',
                    'hover:bg-bg-muted hover:text-content-emphasis',
                    'active:bg-bg-subtle',
                    'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-default',
                    'disabled:pointer-events-none disabled:text-content-subtle disabled:opacity-50',
                )}
                onClick={onClick}
                {...props}
            >
                <Icon className="h-full w-full shrink-0" aria-hidden="true" />
            </button>
        );
        // Radix Tooltip renders nothing on disabled triggers, so skip
        // the wrap — the aria-label still describes the button for
        // assistive tech.
        if (!label || disabled) return button;
        return <Tooltip content={label}>{button}</Tooltip>;
    },
);
NavigationButton.displayName = 'Calendar.NavigationButton';

// ─── Calendar ─────────────────────────────────────────────────────────

export type CalendarProps = DayPickerProps & {
    /** Show the double-chevron year-jump buttons next to the month header. */
    showYearNavigation?: boolean;
};

export function Calendar({
    mode = 'single',
    weekStartsOn = 1,
    numberOfMonths = 1,
    showYearNavigation = false,
    disabled: disabledDays,
    locale,
    className,
    classNames,
    startMonth,
    endMonth,
    ...props
}: CalendarProps) {
    const t = useTranslations('ui');
    const [month, setMonth] = useState<Date>(
        (props as { defaultMonth?: Date }).defaultMonth ?? new Date(),
    );

    const handleMonthChange = (nextMonth: Date) => {
        setMonth(nextMonth);
        (props as { onMonthChange?: (d: Date) => void }).onMonthChange?.(
            nextMonth,
        );
    };

    const previousMonth = addMonths(month, -1);
    const nextMonth = addMonths(month, 1);
    const canGoBack = !startMonth || previousMonth >= startMonth;
    const canGoForward = !endMonth || nextMonth <= endMonth;

    const goToPreviousYear = () => {
        const target = addYears(month, -1);
        if (!startMonth || target.getTime() >= startMonth.getTime()) {
            handleMonthChange(target);
        }
    };

    const goToNextYear = () => {
        const target = addYears(month, 1);
        if (!endMonth || target.getTime() <= endMonth.getTime()) {
            handleMonthChange(target);
        }
    };

    return (
        <DayPicker
            // react-day-picker v9 types `DayPickerProps` as a discriminated
            // union over `mode`; spreading a generic bag + a `mode` literal
            // doesn't satisfy any single branch. Cast the merged object to the
            // public union type — this is the narrowest sound cast available.
            {...({ ...props, mode } as DayPickerProps)}
            month={month}
            onMonthChange={handleMonthChange}
            weekStartsOn={weekStartsOn}
            numberOfMonths={numberOfMonths}
            locale={locale}
            disabled={disabledDays}
            showOutsideDays={numberOfMonths === 1}
            className={cn('bg-bg-default text-content-emphasis', className)}
            startMonth={startMonth}
            endMonth={endMonth}
            data-testid="calendar"
            classNames={{
                months: 'flex space-y-0',
                month: 'space-y-default p-3 w-full',
                nav: 'gap-1 flex items-center justify-between w-full h-full',
                month_grid: 'w-full border-separate border-spacing-y-1',
                weekdays: 'flex',
                weekday:
                    'w-9 font-medium text-xs text-center text-content-muted pb-2 uppercase tracking-wider',
                week: 'w-full flex',
                day: 'relative p-0 text-center text-content-default focus-within:relative',
                day_button: cn(
                    'relative size-10 rounded-md text-sm text-content-default',
                    'transition-colors duration-100',
                    'hover:bg-bg-muted hover:text-content-emphasis',
                    'active:bg-bg-subtle',
                    'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-default',
                ),
                today:
                    'font-semibold [&_button]:ring-1 [&_button]:ring-inset [&_button]:ring-border-default',
                selected: cn(
                    '[&_button]:bg-brand-emphasis [&_button]:text-content-inverted',
                    '[&_button]:hover:bg-brand-emphasis [&_button]:hover:text-content-inverted',
                ),
                disabled:
                    '[&_button]:text-content-subtle [&_button]:line-through [&_button]:hover:bg-transparent [&_button]:pointer-events-none',
                outside: 'text-content-subtle',
                range_middle: cn(
                    '!rounded-none',
                    '[&_button]:bg-brand-subtle [&_button]:text-content-emphasis',
                    '[&_button]:hover:bg-brand-subtle',
                ),
                range_start: 'rounded-r-none !rounded-l',
                range_end: 'rounded-l-none !rounded-r',
                hidden: 'invisible',
                ...classNames,
            }}
            components={{
                Chevron: ({ orientation }) => {
                    const Icon =
                        orientation === 'left' ? ChevronLeft : ChevronRight;
                    return <Icon className="h-4 w-4" aria-hidden="true" />;
                },
                MonthCaption: ({ calendarMonth }) => {
                    const displayMonth = calendarMonth.date;
                    const isFirst = true;
                    const isLast = numberOfMonths === 1;
                    const hideNextButton = numberOfMonths > 1 && !isLast;
                    const hidePreviousButton = numberOfMonths > 1 && !isFirst;

                    return (
                        <div
                            className="flex items-center justify-between"
                            data-testid="calendar-caption"
                        >
                            <div className="flex items-center gap-1">
                                {showYearNavigation && !hidePreviousButton && (
                                    <NavigationButton
                                        disabled={
                                            !canGoBack ||
                                            !!(startMonth &&
                                                addYears(month, -1).getTime() <
                                                    startMonth.getTime())
                                        }
                                        aria-label={t('datePicker.goToPreviousYear')}
                                        data-testid="calendar-prev-year"
                                        onClick={goToPreviousYear}
                                        icon={ChevronsLeft}
                                    />
                                )}
                                {!hidePreviousButton && (
                                    <NavigationButton
                                        disabled={!canGoBack}
                                        aria-label={t('datePicker.goToPreviousMonth')}
                                        data-testid="calendar-prev-month"
                                        onClick={() =>
                                            canGoBack &&
                                            handleMonthChange(previousMonth)
                                        }
                                        icon={ChevronLeft}
                                    />
                                )}
                            </div>

                            <div
                                role="presentation"
                                aria-live="polite"
                                data-testid="calendar-heading"
                                className="text-sm font-semibold capitalize tabular-nums text-content-emphasis"
                            >
                                {format(displayMonth, 'LLLL yyy', {
                                    locale: locale as DateFnsLocale | undefined,
                                })}
                            </div>

                            <div className="flex items-center gap-1">
                                {!hideNextButton && (
                                    <NavigationButton
                                        disabled={!canGoForward}
                                        aria-label={t('datePicker.goToNextMonth')}
                                        data-testid="calendar-next-month"
                                        onClick={() =>
                                            canGoForward &&
                                            handleMonthChange(nextMonth)
                                        }
                                        icon={ChevronRight}
                                    />
                                )}
                                {showYearNavigation && !hideNextButton && (
                                    <NavigationButton
                                        disabled={
                                            !canGoForward ||
                                            !!(endMonth &&
                                                addYears(month, 1).getTime() >
                                                    endMonth.getTime())
                                        }
                                        aria-label={t('datePicker.goToNextYear')}
                                        data-testid="calendar-next-year"
                                        onClick={goToNextYear}
                                        icon={ChevronsRight}
                                    />
                                )}
                            </div>
                        </div>
                    );
                },
            }}
            hideNavigation
        />
    );
}

Calendar.displayName = 'Calendar';
