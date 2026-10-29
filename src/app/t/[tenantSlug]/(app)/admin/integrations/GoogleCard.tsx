'use client';

/* TODO(swr-migration): fetch-on-mount + setState, matching the parent
 * integrations page and SharePointCard. Migrate together to useTenantSWR. */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';

import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiPost } from '@/lib/api-client';
import { useToastWithUndo } from '@/components/ui/hooks';

/**
 * Google Drive + Calendar connection card — #2005.
 *
 * ## Why this shows WHICH products were granted
 *
 * Google's consent screen lets the scopes be ticked individually, so one
 * "Connect Google" can return Calendar granted and Drive denied. The
 * connection row existing therefore does not mean both products work, and a
 * card that said only "Connected" would hide that — the first Drive export
 * would fail with a 403 nobody was warned about.
 *
 * `grantedProducts` comes from `configJson`, which the collection endpoint
 * returns without decrypting the stored credential.
 */
interface GoogleConnection {
    id: string;
    name: string;
    isEnabled: boolean;
    configJson?: {
        grantedProducts?: { drive?: boolean; calendar?: boolean };
    } | null;
    createdAt: string;
}

/**
 * What the sync reports (#2020). Two of these are CONTRACTS, not statistics:
 * `partial` means the sync declined to delete anything, and `skippedEdited`
 * counts events the farmer had edited and we left alone. Rendering a plain
 * success over either one claims a clean run that did not happen, so both get
 * their own notice below.
 */
interface CalendarSyncResult {
    created: number;
    updated: number;
    deleted: number;
    unchanged: number;
    skippedEdited: number;
    partial: boolean;
}

export function GoogleCard() {
    const t = useTranslations('admin.integrations');
    const apiUrl = useTenantApiUrl();
    const searchParams = useSearchParams();
    const triggerUndoToast = useToastWithUndo();

    const [connections, setConnections] = useState<GoogleConnection[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [syncing, setSyncing] = useState(false);
    const [syncResult, setSyncResult] = useState<CalendarSyncResult | null>(null);

    /** Status handed back by the consent callback via the query string. */
    const status = searchParams.get('google');

    const load = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/admin/integrations/google'));
            if (res.ok) setConnections(await res.json());
        } catch {
            /* best effort — the card renders its empty state */
        }
    }, [apiUrl]);

    useEffect(() => {
        void load();
    }, [load]);

    const connect = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/admin/integrations/google/connect'), { method: 'POST' });
            if (!res.ok) {
                setError(t('googleConsentFlowError'));
                return;
            }
            const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
            // Hand off to Google's consent screen. A full navigation rather
            // than a popup: the callback needs a top-level redirect to set and
            // read the HttpOnly state cookie.
            window.location.href = authorizeUrl;
        } catch {
            setError(t('googleConsentFlowError'));
        } finally {
            setBusy(false);
        }
    }, [apiUrl, t]);

    const syncCalendar = useCallback(async () => {
        setSyncing(true);
        setError(null);
        setSyncResult(null);
        try {
            // `apiPost` so the SERVER's message reaches the screen: owner
            // ruling #1677 — the server resolves the locale and sends
            // `message` already translated, and the web reads the error
            // `code` nowhere. A local code->copy map here would be the second
            // catalogue that ruling exists to prevent.
            //
            // The signal is OURS, which is the point: `apiPost` otherwise
            // applies `API_CLIENT_TIMEOUT_MS` (20s) while the route declares
            // `maxDuration = 60`. A first sync on an established farm makes
            // one Google call per changed event and can outrun 20 seconds, so
            // the default would abort the request and report a failure for a
            // sync that went on to succeed. 65s lets the SERVER's own bound
            // fire first and answer with something true.
            const result = await apiPost<CalendarSyncResult>(
                apiUrl('/admin/integrations/google/calendar/sync'),
                {},
                undefined,
                { signal: AbortSignal.timeout(65_000) },
            );
            setSyncResult(result);
            // The calendar id and the stored locale may have just been
            // written, and `grantedProducts` is on the same row.
            void load();
        } catch (err) {
            setError(err instanceof Error ? err.message : t('googleCalendarSyncFailed'));
        } finally {
            setSyncing(false);
        }
    }, [apiUrl, t, load]);

    const disconnect = useCallback(
        (conn: GoogleConnection) => {
            setConnections((cs) => cs.filter((c) => c.id !== conn.id)); // optimistic
            triggerUndoToast({
                message: t('disconnectedToast', { name: conn.name }),
                undoMessage: t('undo'),
                action: async () => {
                    const res = await fetch(apiUrl(`/admin/integrations/google?connectionId=${conn.id}`), {
                        method: 'DELETE',
                    });
                    // 404 is success for this purpose: the row is gone either
                    // way, and failing here would re-add it to the list.
                    if (!res.ok && res.status !== 404) {
                        throw new Error(t('disconnectFailedStatus', { status: res.status }));
                    }
                },
                undoAction: () => load(),
                onError: () => {
                    setError(t('disconnectRestored'));
                    void load();
                },
            });
        },
        [apiUrl, t, triggerUndoToast, load],
    );

    return (
        <Card className="space-y-default p-6">
            <Heading level={2}>{t('googleTitle')}</Heading>
            <p className="text-sm text-content-muted">{t('googleDescription')}</p>

            {status === 'connected' && (
                <InlineNotice variant="success">
                    {t('googleConnected')}
                </InlineNotice>
            )}
            {status === 'connected-partial' && (
                <InlineNotice variant="warning">
                    {t('googleConnectedPartial')}
                </InlineNotice>
            )}
            {status === 'declined' && (
                <InlineNotice variant="warning">
                    {t('googleDeclined')}
                </InlineNotice>
            )}
            {(status === 'error' || status === 'connect_failed') && (
                <InlineNotice variant="error">
                    {t('googleConnectFailed')}
                </InlineNotice>
            )}
            {error && (
                <InlineNotice variant="error">
                    {error}
                </InlineNotice>
            )}
            {syncResult && (
                <InlineNotice variant="success">
                    {t('googleCalendarSyncDone', {
                        created: syncResult.created,
                        updated: syncResult.updated,
                        deleted: syncResult.deleted,
                        unchanged: syncResult.unchanged,
                    })}
                </InlineNotice>
            )}
            {syncResult?.partial && (
                <InlineNotice variant="warning">
                    {t('googleCalendarSyncPartial')}
                </InlineNotice>
            )}
            {syncResult != null && syncResult.skippedEdited > 0 && (
                <InlineNotice variant="warning">
                    {t('googleCalendarSyncSkipped', { count: syncResult.skippedEdited })}
                </InlineNotice>
            )}

            {connections.length === 0 ? (
                <p className="text-sm text-content-muted">{t('googleNoConnection')}</p>
            ) : (
                <ul className="flex flex-col gap-compact">
                    {connections.map((conn) => {
                        const granted = conn.configJson?.grantedProducts ?? {};
                        const drive = granted.drive === true;
                        const calendar = granted.calendar === true;
                        return (
                            <li
                                key={conn.id}
                                className="flex flex-wrap items-center gap-default rounded-md border border-border-subtle p-4"
                            >
                                <span className="text-sm font-medium">{conn.name}</span>
                                <StatusBadge variant={drive ? 'success' : 'neutral'}>
                                    {t('googleDrive')}: {drive ? t('googleGranted') : t('googleNotGranted')}
                                </StatusBadge>
                                <StatusBadge variant={calendar ? 'success' : 'neutral'}>
                                    {t('googleCalendar')}: {calendar ? t('googleGranted') : t('googleNotGranted')}
                                </StatusBadge>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="ml-auto"
                                    onClick={() => disconnect(conn)}
                                >
                                    {t('googleDisconnect')}
                                </Button>
                            </li>
                        );
                    })}
                    {connections.some(
                        (c) =>
                            c.configJson?.grantedProducts?.drive !== true ||
                            c.configJson?.grantedProducts?.calendar !== true,
                    ) && <li className="text-sm text-content-muted">{t('googleReconnectForMissing')}</li>}
                </ul>
            )}

            <div className="flex flex-wrap items-center gap-default">
                <Button onClick={connect} disabled={busy}>
                    {busy ? t('googleConnecting') : t('googleConnect')}
                </Button>
                {/*
                  * Offered when ANY connection reports Calendar granted, not
                  * when the one the sync will USE does. The sync takes the
                  * OLDEST enabled connection (so the destination is unchanged
                  * by connecting a second Google account) and this list
                  * carries no promise of order — encoding one here would be a
                  * second, silent copy of that rule. Where the two disagree
                  * the server refuses with GOOGLE_CALENDAR_NOT_GRANTED, whose
                  * message already says to reconnect and grant Calendar,
                  * which is the actionable answer either way.
                  */}
                {connections.some((c) => c.configJson?.grantedProducts?.calendar === true) && (
                    <Button variant="secondary" onClick={syncCalendar} disabled={syncing}>
                        {syncing ? t('googleCalendarSyncing') : t('googleCalendarSync')}
                    </Button>
                )}
            </div>
            {connections.some((c) => c.configJson?.grantedProducts?.calendar === true) && (
                <p className="text-sm text-content-muted">{t('googleCalendarSyncHint')}</p>
            )}
        </Card>
    );
}
