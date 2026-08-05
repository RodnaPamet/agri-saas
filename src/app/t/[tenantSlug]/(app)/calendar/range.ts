/**
 * The calendar's visible range, computed in ONE place.
 *
 * Why this module exists. The server shell and the client island each used
 * to compute their own range: `page.tsx` built `now ± 180d` (carrying
 * time-of-day) while `CalendarClient` built a midnight-aligned month window,
 * then compared the two as ISO strings to decide whether the server payload
 * could seed React Query. They could never be equal, so `initialMatches` was
 * always false: every page load ran the full multi-source aggregation on the
 * server, serialised it into the RSC payload, threw it away, and refetched
 * the same window from the client.
 *
 * Sharing the helper removes that whole class of bug — the two sides cannot
 * drift, because there is only one arithmetic.
 */

export const DAY_MS = 86_400_000;

/** Midnight UTC on the first day of `d`'s month. */
export function startOfUtcMonth(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** The last millisecond of `d`'s month, UTC. */
export function endOfUtcMonth(d: Date): Date {
    return new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59, 999),
    );
}

/**
 * The range a month view actually needs: the month itself plus a week of
 * padding either side, because the 6×7 grid shows leading days from the
 * previous month and trailing days from the next.
 *
 * Deterministic for a given `monthCursor` — no `Date.now()` inside — so the
 * server and the client produce byte-identical ISO strings for the same
 * cursor. That equality is what lets the server payload seed the client
 * cache instead of being discarded.
 */
export function monthGridRange(monthCursor: Date): { from: Date; to: Date } {
    const start = startOfUtcMonth(monthCursor);
    const end = endOfUtcMonth(monthCursor);
    return {
        from: new Date(start.getTime() - 7 * DAY_MS),
        to: new Date(end.getTime() + 7 * DAY_MS),
    };
}
