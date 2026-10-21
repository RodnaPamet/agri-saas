'use client';

/**
 * Roadmap-14 PR-8 — `<NotificationsBell>` — notification affordance
 * in the top-bar right slot.
 *
 * Mounts between the workspace switcher and the user menu. Shows a
 * bell icon with a count badge for unread notifications; click
 * opens a popover listing recent notifications.
 *
 * Data: REST-polled from `/api/notifications`. A fetch on mount
 * seeds the badge; a fixed-cadence poll (NOTIFICATIONS_POLL_INTERVAL_MS)
 * keeps the unread count live without the user opening the popover;
 * and every popover-open pulls a fresh list. The poll pauses while
 * the browser tab is hidden and refetches on return, so a
 * backgrounded tab never hammers the endpoint.
 *
 * Each notification:
 *
 *   • Title + message (truncated to one + two lines respectively).
 *   • Time (relative, formatted via Intl.RelativeTimeFormat).
 *   • Click → marks-read + navigates to `linkUrl` if present.
 *
 * Empty state uses the R11 personality vocabulary — "All clear"
 * with a calm icon, not a generic "No notifications" sentence.
 *
 * Mark-all-read action lives in the popover footer (bulk verb).
 *
 * Out of scope (separate roadmaps — do not blur in here):
 *   • Real-time push. The bell REST-polls by design; SSE / WebSocket
 *     streaming is a separate infrastructure roadmap. When it lands
 *     it replaces the poll interval below and nothing else — the
 *     fetch/merge/render path is already the seam.
 *   • Notification preferences / settings.
 *   • Per-channel filtering — the count is unread-total only.
 */

import { useCallback, useEffect, useState } from 'react';

import { useRealtime } from '@/lib/realtime/use-realtime';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Bell, CheckCheck } from 'lucide-react';

import { Popover } from '@/components/ui/popover';
import { EmptyState } from '@/components/ui/empty-state';
import { useDateFormat } from '@/lib/i18n/use-date-format';
import { useHydratedNow } from '@/lib/hooks/use-hydrated-now';
import { NAV_BAR_SLOT_PRESS } from './nav-bar';

// ─── Types ─────────────────────────────────────────────────────────

interface NotificationRow {
    id: string;
    type: string;
    title: string;
    message: string;
    read: boolean;
    linkUrl: string | null;
    createdAt: string;
}

// ─── Polling ───────────────────────────────────────────────────────

/**
 * REST-poll cadence for the unread badge. 60s is frequent enough
 * that the count feels live without meaningfully loading the
 * endpoint. This interval IS the real-time mechanism today — a
 * future SSE / WebSocket roadmap would replace it.
 */
const NOTIFICATIONS_POLL_INTERVAL_MS = 60_000;

/**
 * 2026-05-27 (PR-C) — when the SSE channel is open and healthy,
 * the poll throttles to 5 minutes — coverage for the cross-pod
 * gap (a notification created on a pod whose bus subscribers
 * don't include this client will reach the bell within 5 min via
 * the fallback poll). When SSE errors, this drops back to the
 * original 60s.
 */
const NOTIFICATIONS_FALLBACK_POLL_INTERVAL_MS = 5 * 60_000;

// ─── Recipes ───────────────────────────────────────────────────────

const BELL_BUTTON_CLASS =
    `relative inline-flex items-center justify-center h-[22px] w-[22px] rounded-full text-content-muted transition-colors hover:bg-bg-muted/50 hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${NAV_BAR_SLOT_PRESS}`;

const BADGE_OVERLAY_CLASS =
    // Pill chip pinned to the bell's top-right corner. Negative
    // inset puts it slightly outside the bell's bounding box so
    // the bell glyph remains uncluttered.
    'absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-bg-error-emphasis text-[10px] font-semibold text-content-inverted tabular-nums leading-none';

const ROW_CLASS =
    'flex flex-col gap-tight rounded-md px-2.5 py-2 transition-colors hover:bg-bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]';

const ROW_UNREAD_CLASS = 'bg-bg-subtle';

// ─── Helpers ───────────────────────────────────────────────────────

// ─── Component ─────────────────────────────────────────────────────

export function NotificationsBell() {
    const t = useTranslations('notificationsBell');
    /**
     * P2.1 — the bell used to format its own relative times and returned
     * "5m", "2h", "3d": Latin abbreviations, hardcoded, shown to Bulgarian
     * users whatever their language. Only `t('now')` was ever translated.
     * `formatChatTime` gets «преди 5 мин» / «преди 3 ч» from Intl instead.
     *
     * It also called `Date.now()` during render, which is a hydration
     * mismatch by construction — the server and the client compute different
     * nows. `useHydratedNow()` returns null until mounted, which is why the
     * call below passes an absolute date as the FALLBACK: the first paint
     * shows a real date rather than a dash, and upgrades to relative phrasing
     * once hydrated.
     */
    const fmt = useDateFormat();
    const now = useHydratedNow();
    const [open, setOpen] = useState(false);
    const [items, setItems] = useState<NotificationRow[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const close = useCallback(() => setOpen(false), []);

    const fetchList = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch('/api/notifications', {
                credentials: 'same-origin',
            });
            if (!res.ok) {
                throw new Error(t('loadErrorStatus', { status: res.status }));
            }
            const body = (await res.json()) as NotificationRow[];
            setItems(body);
        } catch (e) {
            setError(
                e instanceof Error ? e.message : t('loadError'),
            );
        } finally {
            setLoading(false);
        }
        // `t` is a stable next-intl binding; intentionally omitted so the
        // poll effect that depends on `fetchList` keeps a fixed interval.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /**
     * The realtime signal, on the connection SHARED with every other consumer
     * — P7.6 (#1995).
     *
     * This held its own `EventSource` on `/api/notifications/stream`. Live
     * Борса adding a second would have meant two long-lived connections per
     * TAB, against a cap of three streams per person (P7.2) — so two tabs
     * would exhaust somebody's budget and a third would be refused. The cap is
     * per person because a person is what costs the server, and that only
     * works if a person's browser opens one connection.
     *
     * `useRealtime` owns that one connection and routes by `kind`, so this
     * subscribes to `notification` and Борса will subscribe to `listing`
     * without a second socket.
     *
     * The callback is wrapped in `useCallback` even though the hook holds it in
     * a ref: the hook's contract does not require a stable callback, but
     * passing an unstable one re-registers on every render for no reason.
     */
    const onNotification = useCallback(() => {
        /**
         * Refetch, do not prepend — #1990.
         *
         * The frame carries ids only, so there is no row in it to prepend.
         * That is the phase rule (payloads carry ids; clients fetch bodies
         * over REST with ETag) and it removes a class of bug this code had: a
         * prepended payload is a copy, so a notification edited or deleted
         * between publish and render was displayed anyway, with no version to
         * compare against.
         *
         * The frame's contents are deliberately not read. Reading them to
         * decide whether to refetch would reintroduce a dependency on their
         * shape — and the shape just changed, twice.
         */
        void fetchList();
    }, [fetchList]);

    const realtimeState = useRealtime('notification', onNotification);

    /**
     * REST poll as the fallback, at a cadence DERIVED from the connection.
     *
     * 60s while the stream is idle or erroring, five minutes while it is open
     * — so a cross-pod notification, produced on a pod whose bus subscribers
     * do not include us, still reaches the bell.
     *
     * Derived rather than set imperatively, and that is the fix for #1983
     * made structural. The cadence used to be chosen once, from a health flag
     * read in the same tick that constructed the `EventSource` — so `onopen`
     * could not have fired, the flag was always false, and the five-minute
     * branch was UNREACHABLE: a perfectly healthy stream polled every 60s for
     * ever. Nothing failed, which is why it survived; the only symptom was
     * twice the intended request volume.
     *
     * With the cadence as a function of `realtimeState`, the effect re-runs on
     * every transition and the dead branch cannot come back.
     */
    useEffect(() => {
        fetchList();

        const poll = () => {
            // A hidden tab is not looking, so polling it spends a request to
            // update something nobody can see. `visibilitychange` below
            // catches up the moment it returns.
            if (typeof document !== 'undefined' && document.hidden) return;
            void fetchList();
        };

        const cadence =
            realtimeState === 'open'
                ? NOTIFICATIONS_FALLBACK_POLL_INTERVAL_MS
                : NOTIFICATIONS_POLL_INTERVAL_MS;
        const intervalId = window.setInterval(poll, cadence);

        const onVisibility = () => {
            if (!document.hidden) void fetchList();
        };
        document.addEventListener('visibilitychange', onVisibility);

        return () => {
            window.clearInterval(intervalId);
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, [fetchList, realtimeState]);

    // Opening the popover always pulls a fresh list — the user is
    // looking now, so show current data, not the last poll's.
    useEffect(() => {
        if (!open) return;

        fetchList();
    }, [open, fetchList]);

    const unreadCount = items?.filter((n) => !n.read).length ?? 0;
    const hasItems = (items?.length ?? 0) > 0;

    const handleRowClick = useCallback(
        async (n: NotificationRow) => {
            // Optimistic local mark-as-read so the badge updates the
            // moment the user clicks.
            setItems((prev) =>
                prev
                    ? prev.map((x) => (x.id === n.id ? { ...x, read: true } : x))
                    : prev,
            );
            try {
                await fetch(`/api/notifications/${n.id}`, {
                    method: 'PATCH',
                    credentials: 'same-origin',
                });
            } catch {
                // Server-side mark failed; the local optimistic
                // update remains so the user perceives the row as
                // handled. Next fetch will reconcile if needed.
            }
        },
        [],
    );

    const handleMarkAllRead = useCallback(async () => {
        const unread = items?.filter((n) => !n.read) ?? [];
        if (unread.length === 0) return;
        setItems((prev) =>
            prev ? prev.map((x) => ({ ...x, read: true })) : prev,
        );
        await Promise.all(
            unread.map((n) =>
                fetch(`/api/notifications/${n.id}`, {
                    method: 'PATCH',
                    credentials: 'same-origin',
                }).catch(() => {}),
            ),
        );
    }, [items]);

    return (
        <Popover
            openPopover={open}
            setOpenPopover={setOpen}
            align="end"
            side="bottom"
            sideOffset={8}
            popoverContentClassName="w-[340px] p-1"
            content={
                <Popover.Menu aria-label={t('notifications')}>
                    {/* Header row — count + mark-all-read action */}
                    <div className="flex items-center justify-between px-2.5 py-1.5">
                        <span className="text-[10px] font-semibold uppercase tracking-widest text-content-subtle">
                            {t('notifications')}
                        </span>
                        {unreadCount > 0 && (
                            <button
                                type="button"
                                onClick={handleMarkAllRead}
                                className="inline-flex items-center gap-tight text-xs text-content-muted transition-colors hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] rounded px-1"
                                data-testid="notifications-mark-all-read"
                            >
                                <CheckCheck
                                    className="h-3 w-3"
                                    aria-hidden="true"
                                />
                                {t('markAllRead')}
                            </button>
                        )}
                    </div>

                    <Popover.Separator />

                    {/* Content */}
                    <div
                        className="max-h-[400px] overflow-y-auto"
                        data-testid="notifications-list"
                    >
                        {loading && items === null ? (
                            <div className="px-2.5 py-6 text-center text-xs text-content-muted animate-pulse">
                                {t('loading')}
                            </div>
                        ) : error ? (
                            <div className="px-2.5 py-6 text-center text-xs text-content-error">
                                {error}
                            </div>
                        ) : !hasItems ? (
                            <div className="py-4">
                                <EmptyState
                                    icon={Bell}
                                    title={t('allClear')}
                                    description={t('allClearDesc')}
                                />
                            </div>
                        ) : (
                            items!.map((n) => {
                                const row = (
                                    <>
                                        <div className="flex items-center justify-between gap-tight">
                                            <p className="truncate text-sm font-medium text-content-emphasis">
                                                {n.title}
                                            </p>
                                            <span className="flex-shrink-0 text-[10px] text-content-subtle tabular-nums">
                                                {fmt.formatChatTime(n.createdAt, now, fmt.formatDateCompact(n.createdAt))}
                                            </span>
                                        </div>
                                        <p className="text-xs text-content-muted line-clamp-2">
                                            {n.message}
                                        </p>
                                    </>
                                );
                                const rowClasses = `${ROW_CLASS} ${n.read ? '' : ROW_UNREAD_CLASS}`;
                                return n.linkUrl ? (
                                    <Link
                                        key={n.id}
                                        href={n.linkUrl}
                                        onClick={() => {
                                            close();

                                            handleRowClick(n);
                                        }}
                                        className={rowClasses}
                                        data-testid={`notification-row-${n.id}`}
                                    >
                                        {row}
                                    </Link>
                                ) : (
                                    <button
                                        key={n.id}
                                        type="button"
                                        onClick={() => handleRowClick(n)}
                                        className={`${rowClasses} text-left`}
                                        data-testid={`notification-row-${n.id}`}
                                    >
                                        {row}
                                    </button>
                                );
                            })
                        )}
                    </div>
                </Popover.Menu>
            }
        >
            <button
                type="button"
                className={BELL_BUTTON_CLASS}
                aria-label={
                    unreadCount > 0
                        ? t('unreadNotifications', { count: unreadCount })
                        : t('notifications')
                }
                aria-expanded={open}
                aria-haspopup="menu"
                data-testid="top-chrome-notifications-bell"
            >
                <Bell className="h-4 w-4" aria-hidden="true" />
                {unreadCount > 0 && (
                    <span
                        className={BADGE_OVERLAY_CLASS}
                        aria-hidden="true"
                        data-testid="notifications-unread-badge"
                    >
                        {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                )}
            </button>
        </Popover>
    );
}

