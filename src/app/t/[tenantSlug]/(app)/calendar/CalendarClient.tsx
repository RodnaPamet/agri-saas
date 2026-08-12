'use client';

/**
 * Calendar client island.
 *
 * A single month view. The heatmap and timeline views were removed: the
 * timeline could only ever draw events carrying an `end`, and `AuditCycle`
 * was the sole source that set one, so it rendered empty for every farm;
 * the heatmap showed density for a workload nobody was tracking. Both cost
 * a wider query range than the month actually needs. `GanttTimeline` itself
 * survives — `PlantingBoard` mounts it for crop successions.
 *
 * Selecting a day populates a side panel listing that day's events, each
 * linked to its entity detail page. The header carries the create
 * affordance; double-clicking a day still opens the same modal seeded with
 * that date, but it is no longer the only way in.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import {
    ChevronLeft,
    ChevronRight,
    Calendar as CalIcon,
    Plus,
} from 'lucide-react';
import { CalendarEventLink } from '@/components/ui/CalendarEventLink';
import { cardVariants } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { cn } from '@/lib/cn';

import { Button } from '@/components/ui/button';
import { CalendarMonth } from '@/components/ui/CalendarMonth';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { formatDate } from '@/lib/format-date';
import { dayKeyInTz } from '@/lib/calendar-day-key';
import { getLocalizedMonthNames } from '@/lib/calendar-locale-names';
import { NewTaskModal } from '@/components/tasks/NewTaskModal';
import type {
    CalendarEvent,
    CalendarEventCategory,
    CalendarEventStatus,
    CalendarResponse,
} from '@/app-layer/schemas/calendar.schemas';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { useLocale, useTranslations } from 'next-intl';
import { monthGridRange, startOfUtcMonth } from './range';

interface CalendarClientProps {
    tenantSlug: string;
    initial: CalendarResponse;
    initialRange: { from: string; to: string };
    /**
     * IANA timezone events are bucketed into day cells with — the
     * tenant's `NOTIFICATIONS_TZ`. See calendar-day-key.ts: bucketing
     * by a UTC string slice puts a task due near local midnight on
     * the wrong day for a Bulgaria-based farm.
     */
    tz: string;
}

/** Today as YMD, for seeding the create modal when no day is selected. */
function todayYmd(): string {
    return new Date().toISOString().slice(0, 10);
}

/**
 * Short, human-readable citation label for an AI-news source link — the
 * bare hostname (e.g. "dfz.bg") rather than the full URL. Falls back to
 * the raw string on a malformed URL rather than throwing — this renders
 * inside the side panel, not a validation boundary.
 */
function sourceHostname(url: string): string {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return url;
    }
}

/**
 * Placeholder grid shown while a month's events are still loading.
 *
 * Without this the first paint of an uncached month is a fully-drawn but
 * EMPTY calendar — which reads as "you have nothing scheduled" rather than
 * "still loading", i.e. a confident wrong answer.
 */
function CalendarMonthSkeleton() {
    return (
        <div className="space-y-tight" aria-hidden="true">
            <div className="grid grid-cols-7 gap-tight">
                {Array.from({ length: 7 }).map((_, i) => (
                    <Skeleton key={`h-${i}`} className="h-4" />
                ))}
            </div>
            {Array.from({ length: 6 }).map((_, row) => (
                <div key={`r-${row}`} className="grid grid-cols-7 gap-tight">
                    {Array.from({ length: 7 }).map((_, col) => (
                        <Skeleton key={`c-${row}-${col}`} className="h-20" />
                    ))}
                </div>
            ))}
        </div>
    );
}

export function CalendarClient({
    tenantSlug,
    initial,
    initialRange,
    tz,
}: CalendarClientProps) {
    const [monthCursor, setMonthCursor] = React.useState<Date>(
        () => startOfUtcMonth(new Date()),
    );
    const [selectedDate, setSelectedDate] = React.useState<string | null>(null);
    // Double-click on a day cell, or the header create button, opens the New
    // Task modal with a date pre-filled. `null` keeps the modal closed.
    const [taskCreateDate, setTaskCreateDate] = React.useState<string | null>(
        null,
    );
    const queryClient = useQueryClient();
    const t = useTranslations('calendar');
    const te = useTranslations('calendar.event');
    const tCategory = useTranslations('calendar.category');
    const tStatus = useTranslations('calendar.status');
    const locale = useLocale();

    // Month names in the active UI locale — see calendar-locale-names.ts.
    const monthNames = React.useMemo(
        () => getLocalizedMonthNames(locale, 'long'),
        [locale],
    );

    // Exhaustive over CalendarEventCategory / CalendarEventStatus — a new
    // category or status added to calendar.schemas.ts is a COMPILE ERROR
    // here rather than a raw enum value leaking into the side panel (the
    // same device calendar.ts uses for AgriEvent categories,
    // which once caught a subsidy deadline rendering as "Fair").
    const categoryLabels: Record<CalendarEventCategory, string> = {
        evidence: tCategory('evidence'),
        policy: tCategory('policy'),
        vendor: tCategory('vendor'),
        audit: tCategory('audit'),
        practice: tCategory('practice'),
        task: tCategory('task'),
        risk: tCategory('risk'),
        finding: tCategory('finding'),
        'farm-task': tCategory('farmTask'),
        lease: tCategory('lease'),
        contract: tCategory('contract'),
        planting: tCategory('planting'),
        'agro-signal': tCategory('agroSignal'),
        'agri-event': tCategory('agriEvent'),
        'ai-news': tCategory('aiNews'),
    };
    const statusLabels: Record<CalendarEventStatus, string> = {
        scheduled: tStatus('scheduled'),
        due_soon: tStatus('dueSoon'),
        overdue: tStatus('overdue'),
        done: tStatus('done'),
        unknown: tStatus('unknown'),
    };

    // Pull `getTime()` into a stable primitive so the dep array is
    // statically checkable. We deliberately depend on `monthCursorMs`
    // rather than the live `monthCursor` Date instance — the lint rule sees
    // the missing `monthCursor` dep but the runtime is stable because the
    // timestamp captures the only field `monthGridRange` reads off the Date.
    const monthCursorMs = monthCursor.getTime();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const range = React.useMemo(() => monthGridRange(monthCursor), [monthCursorMs]);

    const fromKey = range.from.toISOString();
    const toKey = range.to.toISOString();

    // The server shell prefetches this exact range via the same helper, so
    // on first paint these keys match and the RSC payload seeds the cache
    // instead of being discarded and immediately refetched.
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

    // Stabilise the array identity — the `?? []` produces a fresh empty
    // array each render, which destabilises the useMemo below.
    const events: CalendarEvent[] = React.useMemo(
        () => calQuery.data?.events ?? [],
        [calQuery.data],
    );

    const selectedEvents = React.useMemo(() => {
        if (!selectedDate) return [];
        // `tz`-aware bucketing — must agree with CalendarMonth's own
        // `dayKeyInTz` bucketing (same `tz` prop, passed below) or the
        // grid and this panel disagree about which day an event falls on.
        return events.filter((e) => dayKeyInTz(e.date, tz) === selectedDate);
    }, [events, selectedDate, tz]);

    const handlePrev = () => {
        setMonthCursor(
            (prev) =>
                new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() - 1, 1)),
        );
    };
    const handleNext = () => {
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
                    {/* The only create affordance used to be an undiscoverable
                        double-click on a day cell, which also had no keyboard
                        path. A real button is focusable and Enter-activatable. */}
                    <Button
                        type="button"
                        variant="primary"
                        icon={<Plus />}
                        onClick={() => setTaskCreateDate(selectedDate ?? todayYmd())}
                    >
                        {t('addTask')}
                    </Button>
                </div>
            </header>

            {/* Range navigation */}
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
                    {monthNames[monthCursor.getUTCMonth()]}{' '}
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

            {/* Error state */}
            {calQuery.isError && (
                <div className="rounded-lg border border-border-error bg-bg-error px-4 py-3 text-sm text-content-error">
                    {t('loadError')}
                </div>
            )}

            {/* Truncation notice — at least one source hit its per-source
                cap server-side. A partial schedule should say so rather
                than silently rendering as complete. */}
            {!calQuery.isError && calQuery.data?.truncated && (
                <div className="rounded-lg border border-border-warning bg-bg-warning px-4 py-3 text-sm text-content-warning">
                    {t('truncatedNotice')}
                </div>
            )}

            {/* Body */}
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-section">
                <div className={cardVariants({ density: 'compact' })}>
                    {/* The grid always renders — even with zero events — so an
                        empty month still shows its full shape rather than a
                        "no deadlines" takeover. While the month is still
                        loading we show the skeleton instead, so an empty grid
                        never stands in for an unanswered question. */}
                    {calQuery.isPending ? (
                        <CalendarMonthSkeleton />
                    ) : (
                        <CalendarMonth
                            month={monthCursor}
                            events={events}
                            onSelectDate={setSelectedDate}
                            onDoubleClickDate={(ymd) => {
                                setSelectedDate(ymd);
                                setTaskCreateDate(ymd);
                            }}
                            selectedYmd={selectedDate}
                            tz={tz}
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
                                    {selectedEvents.map((ev) =>
                                        ev.provenance === 'ai-news' ? (
                                            // AI-derived proposal — deliberately NOT the same
                                            // whole-card-is-a-link shape as every other event
                                            // below: a distinct dashed-border card, a
                                            // confidence badge, and a MANDATORY "Source:"
                                            // citation link, so this never reads as a
                                            // database fact. See CalendarEvent.provenance.
                                            <li
                                                key={ev.id}
                                                data-event-id={ev.id}
                                                data-event-provenance={ev.provenance}
                                                className="rounded border border-dashed border-border-emphasis bg-bg-muted/30 p-2 text-xs space-y-1"
                                            >
                                                <div className="text-[10px] text-content-subtle uppercase tracking-wider">
                                                    {categoryLabels[ev.category]} · {statusLabels[ev.status]}
                                                </div>
                                                <div className="flex items-start justify-between gap-tight">
                                                    <div className="font-medium text-content-emphasis truncate">
                                                        {te(ev.titleKey, ev.titleParams)}
                                                    </div>
                                                    <StatusBadge variant="info" size="sm">
                                                        {t('aiNews.badge')}
                                                    </StatusBadge>
                                                </div>
                                                {ev.confidence != null && (
                                                    <div className="text-content-muted">
                                                        {t('aiNews.confidence', { pct: Math.round(ev.confidence * 100) })}
                                                    </div>
                                                )}
                                                {ev.sourceUrl && (
                                                    <div className="flex items-center gap-1">
                                                        <span className="text-content-subtle">
                                                            {t('aiNews.sourceLabel')}
                                                        </span>
                                                        <CalendarEventLink
                                                            href={ev.sourceUrl}
                                                            external
                                                            className="text-[var(--brand-default)] underline underline-offset-2 hover:no-underline truncate"
                                                        >
                                                            {sourceHostname(ev.sourceUrl)}
                                                        </CalendarEventLink>
                                                    </div>
                                                )}
                                                <p className="text-[10px] text-content-subtle border-t border-border-subtle pt-1">
                                                    {t('aiNews.disclaimer')}
                                                </p>
                                            </li>
                                        ) : (
                                            <li
                                                key={ev.id}
                                                data-event-id={ev.id}
                                            >
                                                <CalendarEventLink
                                                    href={ev.href}
                                                    external={ev.external}
                                                    className="block rounded p-2 text-xs hover:bg-bg-muted transition-colors"
                                                >
                                                    <div className="font-medium text-content-emphasis truncate">
                                                        {te(ev.titleKey, ev.titleParams)}
                                                    </div>
                                                    {ev.detail && (
                                                        <div className="text-content-muted truncate">
                                                            {ev.detail}
                                                        </div>
                                                    )}
                                                    <div className="text-[10px] text-content-subtle uppercase tracking-wider mt-0.5">
                                                        {categoryLabels[ev.category]} · {statusLabels[ev.status]}
                                                    </div>
                                                </CalendarEventLink>
                                            </li>
                                        ),
                                    )}
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

            {/* New Task modal — driven by the header button or a day
                double-click. Mounted unconditionally; `open` practices
                visibility. After create we stay on the calendar, and the
                query invalidation surfaces the new task on its day cell. */}
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
