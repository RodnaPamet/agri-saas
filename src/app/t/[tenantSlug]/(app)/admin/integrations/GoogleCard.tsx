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

export function GoogleCard() {
    const t = useTranslations('admin.integrations');
    const apiUrl = useTenantApiUrl();
    const searchParams = useSearchParams();
    const triggerUndoToast = useToastWithUndo();

    const [connections, setConnections] = useState<GoogleConnection[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

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

            <div>
                <Button onClick={connect} disabled={busy}>
                    {busy ? t('googleConnecting') : t('googleConnect')}
                </Button>
            </div>
        </Card>
    );
}
