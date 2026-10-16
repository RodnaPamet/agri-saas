'use client';

/* TODO(swr-migration): fetch-on-mount + setState, matching the parent
 * integrations page. Migrate together to useTenantSWR. */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { Combobox } from '@/components/ui/combobox';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import Link from 'next/link';
import { useToastWithUndo } from '@/components/ui/hooks';

interface SpConnection {
    id: string;
    name: string;
    isEnabled: boolean;
    configJson: { allowedSiteIds?: string[] } | null;
    lastTestedAt: string | null;
    lastTestStatus: string | null;
}
interface SpSite {
    id: string;
    displayName?: string;
    webUrl?: string;
}

/**
 * SP-1 — SharePoint connection card on Admin → Integrations.
 * Connect (delegated consent), test, choose allowed sites, disconnect.
 */
export function SharePointCard() {
    const t = useTranslations('admin.integrations');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const searchParams = useSearchParams();
    const triggerUndoToast = useToastWithUndo();

    const [connections, setConnections] = useState<SpConnection[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [testResult, setTestResult] = useState<Record<string, string>>({});
    const [sitesFor, setSitesFor] = useState<string | null>(null);
    const [sites, setSites] = useState<SpSite[]>([]);
    const [selectedSites, setSelectedSites] = useState<string[]>([]);

    const spStatus = searchParams.get('sp');

    const load = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/admin/integrations/sharepoint'));
            if (res.ok) setConnections(await res.json());
        } catch {
            /* read-only load */
        }
    }, [apiUrl]);

    // eslint-disable-next-line react-hooks/set-state-in-effect -- the setState lands after an await, in a later task, so this is not the synchronous render cascade the rule is about; the loader is an async useCallback whose deps cannot change while mounted, so it runs once
    useEffect(() => { void load(); }, [load]);

    const connect = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/admin/integrations/sharepoint/connect'), { method: 'POST' });
            if (!res.ok) {
                setError(t('consentFlowError'));
                return;
            }
            const { authorizeUrl } = await res.json();
            window.location.href = authorizeUrl; // hand off to Microsoft consent
        } catch {
            setError(t('consentFlowError'));
        } finally {
            setBusy(false);
        }
    }, [apiUrl]);

    const test = useCallback(
        async (id: string) => {
            setTestResult((r) => ({ ...r, [id]: t('testing') }));
            try {
                const res = await fetch(apiUrl('/admin/integrations/sharepoint/test'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ connectionId: id }),
                });
                const data = await res.json();
                setTestResult((r) => ({ ...r, [id]: data.message ?? (data.ok ? t('ok') : t('failed')) }));
                void load();
            } catch {
                setTestResult((r) => ({ ...r, [id]: t('testFailed') }));
            }
        },
        [apiUrl, load],
    );

    const openSites = useCallback(
        async (conn: SpConnection) => {
            setSitesFor(conn.id);
            setSelectedSites(conn.configJson?.allowedSiteIds ?? []);
            try {
                const res = await fetch(apiUrl(`/admin/integrations/sharepoint/sites?connectionId=${conn.id}`));
                if (res.ok) setSites(await res.json());
            } catch {
                /* ignore */
            }
        },
        [apiUrl],
    );

    const saveSites = useCallback(
        async (id: string) => {
            setBusy(true);
            try {
                await fetch(apiUrl(`/admin/integrations/sharepoint/sites?connectionId=${id}`), {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ siteIds: selectedSites }),
                });
                setSitesFor(null);
                void load();
            } finally {
                setBusy(false);
            }
        },
        [apiUrl, selectedSites, load],
    );

    const disconnect = useCallback(
        (conn: SpConnection) => {
            setConnections((cs) => cs.filter((c) => c.id !== conn.id)); // optimistic
            triggerUndoToast({
                message: t('disconnectedToast', { name: conn.name }),
                undoMessage: t('undo'),
                action: async () => {
                    const res = await fetch(apiUrl(`/admin/integrations/sharepoint?connectionId=${conn.id}`), {
                        method: 'DELETE',
                    });
                    if (!res.ok && res.status !== 404) throw new Error(t('disconnectFailedStatus', { status: res.status }));
                },
                undoAction: () => load(),
                onError: () => {
                    setError(t('disconnectRestored'));
                    void load();
                },
            });
        },
        [apiUrl, triggerUndoToast, load],
    );

    const siteOptions = sites.map((s) => ({ value: s.id, label: s.displayName ?? s.webUrl ?? s.id }));

    return (
        <Card className="space-y-default p-6">
            <div className="flex items-center justify-between">
                <Heading level={2}>{t('spTitle')}</Heading>
                <div className="flex items-center gap-default">
                    {connections.length > 0 && (
                        <Link href={tenantHref('/admin/integrations/sharepoint-health')} className="text-sm text-content-link">
                            {t('syncHealthLink')}
                        </Link>
                    )}
                    {connections.length === 0 && (
                        <Button variant="primary" onClick={connect} disabled={busy}>
                            {busy ? t('connecting') : t('connect')}
                        </Button>
                    )}
                </div>
            </div>
            <p className="text-sm text-content-muted">
                {t('spDescription')}
            </p>

            {spStatus === 'connected' && <InlineNotice variant="success">{t('spConnected')}</InlineNotice>}
            {spStatus === 'declined' && <InlineNotice variant="warning">{t('spDeclined')}</InlineNotice>}
            {spStatus === 'error' && <InlineNotice variant="error">{t('spConnectFailed')}</InlineNotice>}
            {error && <InlineNotice variant="error">{error}</InlineNotice>}

            {connections.map((conn) => (
                <div key={conn.id} className="rounded-md border border-border-subtle p-4 space-y-default">
                    <div className="flex items-center gap-default">
                        <span className="font-medium text-content-default">{conn.name}</span>
                        <StatusBadge variant={conn.lastTestStatus === 'error' ? 'error' : 'success'}>
                            {conn.lastTestStatus === 'error' ? t('error') : t('connected')}
                        </StatusBadge>
                        <span className="text-xs text-content-muted">
                            {t('sitesAllowed', { count: conn.configJson?.allowedSiteIds?.length ?? 0 })}
                        </span>
                        <div className="ml-auto flex gap-tight">
                            <Button variant="ghost" size="sm" onClick={() => test(conn.id)}>{t('test')}</Button>
                            <Button variant="ghost" size="sm" onClick={() => openSites(conn)}>{t('sites')}</Button>
                            <Button variant="ghost" size="sm" onClick={() => disconnect(conn)}>{t('disconnect')}</Button>
                        </div>
                    </div>
                    {testResult[conn.id] && (
                        <p className="text-xs text-content-muted">{testResult[conn.id]}</p>
                    )}
                    {sitesFor === conn.id && (
                        <div className="space-y-default border-t border-border-subtle pt-default">
                            <p className="text-sm text-content-muted">{t('chooseSites')}</p>
                            <Combobox
                                id={`sp-sites-${conn.id}`}
                                multiple
                                options={siteOptions}
                                selected={siteOptions.filter((o) => selectedSites.includes(o.value))}
                                setSelected={(opts) => setSelectedSites(opts.map((o) => o.value))}
                                placeholder={t('selectSites')}
                                matchTriggerWidth
                            />
                            <div className="flex justify-end gap-tight">
                                <Button variant="ghost" size="sm" onClick={() => setSitesFor(null)}>{t('cancel')}</Button>
                                <Button variant="secondary" size="sm" onClick={() => saveSites(conn.id)} disabled={busy}>
                                    {t('saveSites')}
                                </Button>
                            </div>
                        </div>
                    )}
                </div>
            ))}
        </Card>
    );
}
