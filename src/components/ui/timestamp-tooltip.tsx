'use client';

/**
 * Epic 63 — `<TimestampTooltip>`.
 *
 * Canonical primitive for "show relative time, hover for the exact
 * moment". Replaces every ad-hoc
 * `<span title={iso}>{format(date)}</span>` pattern across the app
 * so list/table cells stay consistent.
 *
 *   <TimestampTooltip date={ev.updatedAt} />
 *   <TimestampTooltip date={task.dueAt} prefix="Due" />
 *   <TimestampTooltip date={practice.createdAt} prefix="Created" />
 *
 * Visible text — relative ("2 hours ago", "in 3 days", "less than a
 * minute ago"). `prefix` prepends a label like "Updated" /
 * "Created" / "Due" without disturbing the relative phrasing.
 *
 * Tooltip — the long-form exact timestamp from
 * `formatDateTimeLong` ("Thursday, 16 April 2026, 08:00:45"),
 * deterministic across server + client (en-GB / UTC).
 *
 * Hydration safety — relative time depends on "now", which differs
 * between SSR and the first client paint. The component renders the
 * **exact** timestamp during the SSR + first-client window (when
 * `useHydratedNow()` is still null) and switches to the relative
 * form once the client mounts. The string the server emits matches
 * what the client emits on the same first render, so React doesn't
 * flag a hydration mismatch.
 */

import { formatDateTimeLong, formatRelativeTime } from '@/lib/format-date';
import { useHydratedNow } from '@/lib/hooks/use-hydrated-now';
import { Tooltip } from '@/components/ui/tooltip';

export interface TimestampTooltipProps {
    /** Date to render. ISO string or Date. Null/undefined → `empty`. */
    date: string | Date | null | undefined;
    /** Optional label prepended to the relative time, e.g. "Updated", "Due". */
    prefix?: string;
    /** Visible text when `date` is null / undefined / unparseable. Default `"—"`. */
    empty?: string;
    /**
     * Pin "now" for the relative calculation.
     *   - omit (undefined) → use `useHydratedNow()` internally
     *   - explicit `Date` → use that value
     *   - explicit `null` → render as if hydration hasn't happened yet
     *     (visible text falls back to the deterministic exact timestamp).
     *     Used by tests to pin the SSR / first-client-render window.
     */
    now?: Date | null;
    /** Extra className on the trigger span. */
    className?: string;
    /**
     * Override the tooltip side. Default `"top"` (Radix Tooltip default
     * is `"top"` too — exposed here for callers in dense rows).
     */
    tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
    /** Optional `data-testid` on the trigger span — useful for E2E. */
    'data-testid'?: string;
}

export function TimestampTooltip({
    date,
    prefix,
    empty = '—',
    now,
    className,
    tooltipSide,
    'data-testid': testId,
}: TimestampTooltipProps) {
    const hydratedNow = useHydratedNow();
    // Distinguish "caller didn't supply now" (use the hook) from
    // "caller explicitly passed null" (force the SSR fallback path).
    // `??` would treat both the same — semantic-undefined check is
    // intentional here.
    const effectiveNow = now === undefined ? hydratedNow : now;

    // Null / undefined / unparseable → static placeholder, no
    // tooltip wrapping (no useful exact timestamp to show).
    const exact = formatDateTimeLong(date, '');
    if (!exact) {
        return (
            <span className={className} data-testid={testId}>
                {empty}
            </span>
        );
    }

    // Relative form requires a real "now". During SSR + first
    // client render, fall back to the exact timestamp so server
    // and client emit the identical string. After hydration,
    // `useHydratedNow()` flips to a real Date and the text
    // re-renders into the relative phrasing on the next frame.
    const relative = effectiveNow
        ? formatRelativeTime(date, effectiveNow, {}, exact)
        : exact;

    const visible = prefix ? `${prefix} ${relative}` : relative;

    return (
        <Tooltip content={exact} side={tooltipSide ?? 'top'}>
            <span
                className={className}
                data-testid={testId}
                data-timestamp-tooltip
            >
                {visible}
            </span>
        </Tooltip>
    );
}

export default TimestampTooltip;
