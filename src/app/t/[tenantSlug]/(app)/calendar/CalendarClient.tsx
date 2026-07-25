'use client';

/**
 * Epic 49 — Compliance Calendar client island.
 *
 * Three views: Heatmap (12 months back), Month (single month grid),
 * Gantt (12 months centred on today, audit-cycle/range-bearing
 * events only). View toggle drives both the rendered component AND
 * the query range (heatmap fetches 12 months back, Gantt fetches
 * a 12-month centred window, Month fetches just the visible month +
 * adjacent padding for the 6×7 grid).
 *
 * Selected day populates a side panel listing every event that day,
 * each linked to its entity detail page.
 */

import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { ChevronLeft, ChevronRight, Calendar as CalIcon } from 'lucide-react';
import Link from 'next/link';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';

import { Button } from '@/components/ui/button';
import { CalendarHeatmap } from '@/components/ui/CalendarHeatmap';
import { CalendarMonth } from '@/components/ui/CalendarMonth';
import { GanttTimeline } from '@/components/ui/GanttTimeline';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { queryKeys } from '@/lib/queryKeys';
import { formatDate } from '@/lib/format-date';
import { NewTaskModal } from '@/components/tasks/NewTaskModal';
import { useQueryClient } from '@tanstack/react-query';
import type {
    CalendarEvent,
    CalendarResponse,
} from '@/app-layer/schemas/calendar.schemas';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { useTranslations } from 'next-intl';

const DAY_MS = 86_400_000;

type View = 'heatmap' | 'month' | 'gantt';

interface CalendarClientProps {
    tenantSlug: string;
    initial: CalendarResponse;
    initialRange: { from: string; to: string };
}

function startOfUtcMonth(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function endOfUtcMonth(d: Date): Date {
    return new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59, 999),
    );
}

function rangeForView(view: View, monthCursor: Date): { from: Date; to: Date } {
    const today = new Date();
    if (view === 'heatmap') {
        return {
            from: new Date(today.getTime() - 365 * DAY_MS),
            to: today,
        };
    }
    if (view === 'gantt') {
        return {
            from: new Date(today.getTime() - 180 * DAY_MS),
            to: new Date(today.getTime() + 180 * DAY_MS),
        };
    }
    // month — pad to cover the 6-row grid
    const start = startOfUtcMonth(monthCursor);
    const end = endOfUtcMonth(monthCursor);
    return {
        from: new Date(start.getTime() - 7 * DAY_MS),
        to: new Date(end.getTime() + 7 * DAY_MS),
    };
}

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

export function CalendarClient({
    tenantSlug,
    initial,
    initialRange,
}: CalendarClientProps) {
    const [view, setView] = React.useState<View>('month');
    const [monthCursor, setMonthCursor] = React.useState<Date>(
        () => startOfUtcMonth(new Date()),
    );
    const [selectedDate, setSelectedDate] = React.useState<string | null>(null);
    // PR-C — double-click on a day cell opens the New Task modal
    // with that date pre-filled as the due date. `taskCreateDate`
    // is the YMD seeding the modal; `null` keeps the modal closed.
    const [taskCreateDate, setTaskCreateDate] = React.useState<string | null>(
        null,
    );
    const queryClient = useQueryClient();
    const t = useTranslations('calendar');

    // Pull `getTime()` into a stable primitive so the dep array is
    // statically checkable. We deliberately depend on `monthCursorMs`
    // rather than the live `monthCursor` Date instance — the lint
    // rule sees the missing `monthCursor` dep but the runtime is
    // stable because the timestamp captures the only field
    // `rangeForView` reads off the Date.
    const monthCursorMs = monthCursor.getTime();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const range = React.useMemo(() => rangeForView(view, monthCursor), [view, monthCursorMs]);

    const fromKey = range.from.toISOString();
    const toKey = range.to.toISOString();

    // Initial server-rendered range happens to overlap with the default
    // (month) view — feed that as initialData when the keys match.
    const initialMatches =
        initialRange.from === fromKey && initialRange.to === toKey;

    const calQuery = useQuery({
        queryKey: queryKeys.calendar.range(tenantSlug, fromKey, toKey),
        queryFn: async (): Promise<CalendarResponse> => {
            const url = `/api/t/${tenantSlug}/calendar?from=${encodeURIComponent(fromKey)}&to=${encodeURIComponent(toKey)}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error('Failed to load calendar');
            return res.json();
        },
        initialData: initialMatches ? initial : undefined,
        staleTime: 60_000,
    });

    // Stabilise the array identity — the `?? []` produces a fresh
    // empty array each render, which destabilises the useMemos
    // below that depend on `events`.
    const events: CalendarEvent[] = React.useMemo(
        () => calQuery.data?.events ?? [],
        [calQuery.data],
    );

    // Filter: Gantt only shows events that have a meaningful range OR
    // are audit cycles (where `start === end` may be intentional).
    const ganttEvents = React.useMemo(
        () =>
            events.filter(
                (e) => e.end !== undefined || e.category === 'audit',
            ),
        [events],
    );

    const selectedEvents = React.useMemo(() => {
        if (!selectedDate) return [];
        return events.filter((e) => e.date.slice(0, 10) === selectedDate);
    }, [events, selectedDate]);

    const handlePrev = () => {
        if (view !== 'month') return;
        setMonthCursor(
            (prev) =>
                new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() - 1, 1)),
        );
    };
    const handleNext = () => {
        if (view !== 'month') return;
        setMonthCursor(
            (prev) =>
                new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 1)),
        );
    };

    return (
        <div className="space-y-section animate-fadeIn">
            {/* Header */}
            <header className="flex items-start justify-between gap-default flex-wrap">
                <div className="min-w-0">
                    <PageBreadcrumbs
                        items={[
                            { label: t('dashboard'), href: `/t/${tenantSlug}/dashboard` },
                            { label: t('breadcrumb') },
                        ]}
                        className="mb-1"
                    />
                    <Heading level={1} className="flex items-center gap-tight">
                        <CalIcon className="size-6 text-content-muted" aria-hidden="true" />
                        {t('title')}
                    </Heading>
                    <p className="text-sm text-content-muted mt-1">
                        {t('description')}
                    </p>
                </div>
                <div className="flex items-center gap-tight flex-wrap">
                    <ToggleGroup
                        selected={view}
                        selectAction={(v) => setView(v as View)}
                        options={[
                            { value: 'month', label: t('viewMonth') },
                            { value: 'heatmap', label: t('viewHeatmap') },
                            { value: 'gantt', label: t('viewTimeline') },
                        ]}
                        size="sm"
                        ariaLabel={t('viewAriaLabel')}
                    />
                </div>
            </header>

            {/* Range navigation (month view only) */}
            {view === 'month' && (
                <div
                    className={cn(cardVariants({ density: 'none' }), 'flex items-center justify-between px-4 py-2')}
                    data-testid="calendar-month-nav"
                >
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={handlePrev}
                        aria-label={t('prevMonth')}
                    >
                        <ChevronLeft className="size-4" />
                    </Button>
                    <span
                        className="text-sm font-semibold text-content-emphasis"
                        data-testid="calendar-current-month"
                    >
                        {MONTH_NAMES[monthCursor.getUTCMonth()]}{' '}
                        {monthCursor.getUTCFullYear()}
                    </span>
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={handleNext}
                        aria-label={t('nextMonth')}
                    >
                        <ChevronRight className="size-4" />
                    </Button>
                </div>
            )}

            {/* Loading + error states */}
            {calQuery.isError && (
                <div className="rounded-lg border border-border-error bg-bg-error px-4 py-3 text-sm text-content-error">
                    {t('loadError')}
                </div>
            )}

            {/* Body — view switch */}
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-section">
                <div className={cardVariants({ density: 'compact' })}>
                    {/* The calendar/heatmap/timeline always renders — even
                        with zero events — so an empty month still shows its
                        full grid (no "No deadlines in this range" takeover).
                        Each view handles the empty case itself (empty cells /
                        empty heatmap / the timeline's own empty message). */}
                    {view === 'heatmap' ? (
                        <CalendarHeatmap
                            events={events}
                            from={range.from}
                            to={range.to}
                            onSelectDate={setSelectedDate}
                        />
                    ) : view === 'month' ? (
                        <CalendarMonth
                            month={monthCursor}
                            events={events}
                            onSelectDate={setSelectedDate}
                            // PR-C — double-click → New Task modal
                            // seeded with the clicked day's date.
                            onDoubleClickDate={(ymd) => {
                                setSelectedDate(ymd);
                                setTaskCreateDate(ymd);
                            }}
                            selectedYmd={selectedDate}
                        />
                    ) : (
                        <GanttTimeline
                            from={range.from}
                            to={range.to}
                            events={ganttEvents}
                            emptyMessage={t('ganttEmpty')}
                        />
                    )}
                </div>

                {/* Side panel — selected day's events */}
                <aside
                    className={cardVariants({ density: 'compact' })}
                    data-testid="calendar-side-panel"
                >
                    {selectedDate ? (
                        <>
                            <Heading level={3} className="mb-2">
                                {formatDate(new Date(selectedDate))}
                            </Heading>
                            {selectedEvents.length === 0 ? (
                                <p className="text-xs text-content-muted">
                                    {t('noEventsDay')}
                                </p>
                            ) : (
                                <ul className="space-y-tight">
                                    {selectedEvents.map((ev) => (
                                        <li
                                            key={ev.id}
                                            data-event-id={ev.id}
                                        >
                                            <Link
                                                href={ev.href}
                                                className="block rounded p-2 text-xs hover:bg-bg-muted transition-colors"
                                            >
                                                <div className="font-medium text-content-emphasis truncate">
                                                    {ev.title}
                                                </div>
                                                {ev.detail && (
                                                    <div className="text-content-muted truncate">
                                                        {ev.detail}
                                                    </div>
                                                )}
                                                <div className="text-[10px] text-content-subtle uppercase tracking-wider mt-0.5">
                                                    {ev.category} · {ev.status}
                                                </div>
                                            </Link>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </>
                    ) : (
                        <p className="text-xs text-content-muted">
                            {t('clickDay')}
                        </p>
                    )}
                </aside>
            </div>

            {/* PR-C — New Task modal driven by calendar double-click.
                Mounted unconditionally; the `open` prop controls
                visibility. `initialDueAt` seeds the form's dueAt
                field with the YMD of the clicked day. After create,
                we stay on the calendar (the queryClient
                invalidation surfaces the new task immediately on
                the affected day cell). */}
            <NewTaskModal
                open={taskCreateDate !== null}
                setOpen={(next) => {
                    const open =
                        typeof next === 'function'
                            ? next(taskCreateDate !== null)
                            : next;
                    if (!open) setTaskCreateDate(null);
                }}
                initialDueAt={taskCreateDate ?? undefined}
                onCreated={() => {
                    setTaskCreateDate(null);
                    queryClient.invalidateQueries({
                        queryKey: queryKeys.calendar.all(tenantSlug),
                    });
                }}
            />
        </div>
    );
}
