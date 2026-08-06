"use client";

/**
 * Epic 49 — <GanttTimeline>.
 *
 * Horizontal timeline for duration-based compliance events. One row
 * per event, bar from `date` (start) to `end`. Today marker as a
 * vertical line. Click-through via the event's `href`.
 *
 * Today the only duration entity is `audit-cycle`; point-in-time
 * events with no `end` render as a 1-day-wide marker so the timeline
 * still shows everything in scope (useful for "remediation plan
 * targets within the audit window" overlays). Pass an explicitly
 * filtered events array if you want only true ranges.
 *
 * Token-styled, no external chart dep — the time axis is a CSS-grid
 * trick. Keeps the component small and the bundle cost negligible.
 */

import * as React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import type {
    CalendarEvent,
} from '@/app-layer/schemas/calendar.schemas';
import { getCategoryTone } from '@/lib/design/status-tone';
import { getLocalizedMonthNames } from '@/lib/calendar-locale-names';

// ─── Public props ─────────────────────────────────────────────────────

export interface GanttTimelineProps {
    /** Inclusive timeline start. */
    from: Date;
    /** Inclusive timeline end. */
    to: Date;
    /** Events to plot — typically pre-filtered to duration-bearing types. */
    events: ReadonlyArray<CalendarEvent>;
    /** Override "today" for the vertical marker (tests). */
    today?: Date;
    /** Empty-state message override. */
    emptyMessage?: string;
    className?: string;
    'data-testid'?: string;
}

// ─── Token map (mirrors CalendarMonth) ───────────────────────────────
//
// Polish PR-7 — bar tone delegates to `getCategoryTone` from
// `@/lib/design/status-tone`. The Gantt bar uses the bg/border slots
// of the shared bundle with `/70` opacity for the fill, so calendar
// + gantt feel like one system.

// ─── Helpers ────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

function clamp(n: number, lo: number, hi: number): number {
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
}

function pctBetween(t: number, from: number, to: number): number {
    if (to <= from) return 0;
    return ((t - from) / (to - from)) * 100;
}

/**
 * Pick ~6-12 axis ticks across the range. Dynamically chooses month
 * boundaries (when range >= 60 days) or weekly markers for tighter
 * windows. Keeps the axis readable without a chart library.
 *
 * `shortMonthNames` is locale-derived (see calendar-locale-names.ts)
 * rather than a hardcoded English array — passed in so this stays a
 * pure function callers memoize on.
 */
function buildTicks(
    from: Date,
    to: Date,
    shortMonthNames: readonly string[],
): { date: Date; label: string }[] {
    const days = (to.getTime() - from.getTime()) / DAY_MS;
    const ticks: { date: Date; label: string }[] = [];

    if (days >= 60) {
        // Monthly ticks
        const cursor = new Date(
            Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1),
        );
        while (cursor.getTime() <= to.getTime()) {
            if (cursor.getTime() >= from.getTime()) {
                ticks.push({
                    date: new Date(cursor),
                    label:
                        cursor.getUTCMonth() === 0
                            ? `${shortMonthNames[cursor.getUTCMonth()]} ${cursor.getUTCFullYear()}`
                            : shortMonthNames[cursor.getUTCMonth()],
                });
            }
            cursor.setUTCMonth(cursor.getUTCMonth() + 1);
        }
    } else {
        // Weekly ticks
        const stepMs = 7 * DAY_MS;
        for (let t = from.getTime(); t <= to.getTime(); t += stepMs) {
            const d = new Date(t);
            ticks.push({
                date: d,
                label: `${shortMonthNames[d.getUTCMonth()]} ${d.getUTCDate()}`,
            });
        }
    }
    return ticks;
}

// ─── Component ───────────────────────────────────────────────────────

export function GanttTimeline({
    from,
    to,
    events,
    today,
    emptyMessage,
    className,
    'data-testid': dataTestId = 'gantt-timeline',
}: GanttTimelineProps) {
    const t = useTranslations('ui');
    // Event titles are i18n keys resolved here — see CalendarEvent.titleKey.
    const te = useTranslations('calendar.event');
    const locale = useLocale();
    const resolvedEmptyMessage =
        emptyMessage ?? t('ganttTimeline.emptyMessage');
    const todayDate = today ?? new Date();
    const fromMs = from.getTime();
    const toMs = to.getTime();

    // Short month names in the active UI locale — see
    // calendar-locale-names.ts for the bg-locale numeric fallback.
    const shortMonthNames = React.useMemo(
        () => getLocalizedMonthNames(locale, 'short'),
        [locale],
    );

    // eslint-disable-next-line react-hooks/exhaustive-deps -- using ms-since-epoch as stable identity
    const ticks = React.useMemo(() => buildTicks(from, to, shortMonthNames), [fromMs, toMs, shortMonthNames]);

    // Sort events: by start ascending, then by duration descending.
    const sorted = React.useMemo(() => {
        return [...events].sort((a, b) => {
            const sa = new Date(a.date).getTime();
            const sb = new Date(b.date).getTime();
            if (sa !== sb) return sa - sb;
            const da = a.end ? new Date(a.end).getTime() - sa : 0;
            const db = b.end ? new Date(b.end).getTime() - sb : 0;
            return db - da;
        });
    }, [events]);

    const todayPct = pctBetween(todayDate.getTime(), fromMs, toMs);
    const todayInRange =
        todayDate.getTime() >= fromMs && todayDate.getTime() <= toMs;

    if (sorted.length === 0) {
        return (
            <div
                className={cn(
                    'rounded-lg border border-border-subtle bg-bg-muted/30 p-12 text-center text-sm text-content-muted',
                    className,
                )}
                data-testid={dataTestId}
            >
                {resolvedEmptyMessage}
            </div>
        );
    }

    return (
        <div
            className={cn('flex flex-col gap-tight', className)}
            data-testid={dataTestId}
            role="list"
            aria-label={t('ganttTimeline.ariaLabel')}
        >
            {/* Axis */}
            <div className="relative h-6 border-b border-border-subtle">
                {ticks.map((tick) => {
                    const left = pctBetween(tick.date.getTime(), fromMs, toMs);
                    return (
                        <span
                            key={tick.date.toISOString()}
                            className="absolute top-0 -translate-x-1/2 text-[10px] text-content-muted"
                            style={{ left: `${clamp(left, 0, 100)}%` }}
                        >
                            {tick.label}
                        </span>
                    );
                })}
            </div>

            {/* Rows */}
            <div className="relative flex flex-col gap-1">
                {/* Today vertical marker */}
                {todayInRange && (
                    <div
                        className="absolute top-0 bottom-0 w-px bg-[var(--brand-emphasis)]/70 z-10 pointer-events-none"
                        style={{ left: `${todayPct}%` }}
                        aria-hidden="true"
                        data-testid="gantt-today-marker"
                    />
                )}

                {sorted.map((ev) => {
                    const startMs = new Date(ev.date).getTime();
                    const endMs = ev.end
                        ? new Date(ev.end).getTime()
                        : startMs + DAY_MS;
                    const clampedStart = Math.max(startMs, fromMs);
                    const clampedEnd = Math.min(endMs, toMs);
                    const left = pctBetween(clampedStart, fromMs, toMs);
                    const width = Math.max(
                        0.5,
                        pctBetween(clampedEnd, fromMs, toMs) - left,
                    );

                    return (
                        <div
                            key={ev.id}
                            role="listitem"
                            className="relative h-7 flex items-center"
                            data-event-id={ev.id}
                            data-event-category={ev.category}
                        >
                            <Link
                                href={ev.href}
                                title={`${te(ev.titleKey, ev.titleParams)}${ev.detail ? ` — ${ev.detail}` : ''}`}
                                className={cn(
                                    'absolute top-1 bottom-1 rounded border px-1 flex items-center text-[10px] font-medium text-content-emphasis truncate min-w-[8px]',
                                    'hover:ring-1 hover:ring-content-emphasis/40 transition-colors duration-150 ease-out',
                                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                                    // Polish PR-7 — getCategoryTone gives the
                                    // canonical bg + border for this category;
                                    // /70 opacity matches the prior CATEGORY_BAR
                                    // fill rhythm.
                                    `${getCategoryTone(ev.category).bg}/70`,
                                    getCategoryTone(ev.category).border,
                                    ev.status === 'overdue' && 'border-status-danger',
                                    ev.status === 'done' && 'opacity-50',
                                )}
                                style={{
                                    left: `${left}%`,
                                    width: `${width}%`,
                                }}
                            >
                                <span className="truncate">{te(ev.titleKey, ev.titleParams)}</span>
                            </Link>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
