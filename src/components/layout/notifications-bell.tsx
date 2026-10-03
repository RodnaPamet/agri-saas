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
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Bell, CheckCheck } from 'lucide-react';

import { Popover } from '@/components/ui/popover';
import { EmptyState } from '@/components/ui/empty-state';
import { useDateFormat } from '@/lib/i18n/use-date-format';
import { useHydratedNow } from '@/lib/hooks/use-hydrated-now';
import { env } from '@/env';
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

    // 2026-05-27 (PR-C) — SSE-first with REST poll as a fallback.
    // Primary signal: an EventSource subscription to
    // `/api/notifications/stream`. Each server-side notification
    // create emits an event; the bell prepends it to the list the
    // moment it lands — no 60s wait. The browser's EventSource
    // handles reconnect automatically after network blips.
    //
    // Fallback path: the original 60s REST poll stays in place but
    // throttled to ~5 minutes when SSE is healthy (so a cross-pod
    // notification — produced on a pod whose bus subscribers don't
    // include us — still reaches the bell within five minutes).
    // If the SSE connection errors (single-process bus on a
    // restart-friendly platform, or a corporate proxy stripping
    // text/event-stream), we drop back to the 60s cadence so the
    // user keeps seeing the unread count tick.
    useEffect(() => {
        fetchList();

        let sseHealthy = false;
        let es: EventSource | null = null;
        // typeof check — SSR + jsdom unit tests both lack EventSource.
        // Feature flag: NEXT_PUBLIC_NOTIFICATIONS_SSE=1 opts the
        // client into the SSE channel. Defaults OFF so the bell keeps
        // polling — the server-side bus + endpoint stay wired (so
        // future opt-in is one env-var flip), but E2E specs that wait
        // on `networkidle` aren't blocked by a long-lived stream that
        // never lets the page settle. Flip when the client integration
        // has been manually verified end-to-end (browser → bell →
        // event arriving inside <1s).
        const sseEnabled = env.NEXT_PUBLIC_NOTIFICATIONS_SSE === '1';
        if (sseEnabled && typeof EventSource !== 'undefined') {
            try {
                es = new EventSource('/api/notifications/stream', {
                    withCredentials: true,
                });
                es.onopen = () => {
                    sseHealthy = true;
                };
                es.onmessage = (msg) => {
                    try {
                        const event = JSON.parse(msg.data) as NotificationRow;
                        // Prepend if not already present (dedupe by id —
                        // the server includes the row id OR the dedupeKey
                        // as id so cross-channel duplicates collapse).
                        setItems((prev) => {
                            const list = prev ?? [];
                            if (list.some((n) => n.id === event.id)) return list;
                            return [event, ...list];
                        });
                    } catch {
                        // Malformed event — refetch to recover.
                        void fetchList();
                    }
                };
                es.onerror = () => {
                    sseHealthy = false;
                };
            } catch {
                sseHealthy = false;
            }
        }

        const pollIntervalMs = sseHealthy
            ? NOTIFICATIONS_FALLBACK_POLL_INTERVAL_MS
            : NOTIFICATIONS_POLL_INTERVAL_MS;
        const poll = () => {
            if (typeof document !== 'undefined' && document.hidden) return;
            void fetchList();
        };
        const intervalId = window.setInterval(poll, pollIntervalMs);
        const onVisibility = () => {
            if (!document.hidden) void fetchList();
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            window.clearInterval(intervalId);
            document.removeEventListener('visibilitychange', onVisibility);
            if (es) es.close();
        };
    }, [fetchList]);

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

