'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { useDateFormat } from '@/lib/i18n/use-date-format';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { CloudCog, Trash2, Copy, Check, AlertTriangle, Clock, ExternalLink, Plus } from 'lucide-react';
import { useToast } from '@/components/ui/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { useCopyToClipboard } from '@/components/ui/hooks';
import { CopyButton } from '@/components/ui/copy-button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { Card, cardVariants } from '@/components/ui/card';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';

interface ScimToken {
    id: string;
    label: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
    createdAt: string;
}

interface ScimState {
    tokens: ScimToken[];
    scimEndpoint: string;
    isEnabled: boolean;
}

export default function ScimAdminPage() {
    const { formatDate } = useDateFormat();
    const t = useTranslations('admin.scim');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const [state, setState] = useState<ScimState | null>(null);
    const [loading, setLoading] = useState(true);
    const [generating, setGenerating] = useState(false);
    const [newTokenPlaintext, setNewTokenPlaintext] = useState<string | null>(null);
    const [newLabel, setNewLabel] = useState('');
    const [showForm, setShowForm] = useState(false);
    const { copy, copied } = useCopyToClipboard({ timeout: 2500 });
    const toast = useToast();
    const [error, setError] = useState<string | null>(null);
    const [tokenIdToRevoke, setTokenIdToRevoke] = useState<string | null>(null);

    const fetchTokens = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/admin/scim'));
            if (res.ok) {
                setState(await res.json());
            } else if (res.status === 401 || res.status === 403) {
                setError(t('noPermission'));
            } else {
                setError(t('loadFailedStatus', { status: res.status }));
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : t('loadFailed'));
        } finally {
            setLoading(false);
        }
    }, [apiUrl]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchTokens(); }, [fetchTokens]);

    const generateToken = async () => {
        setGenerating(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/admin/scim'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ label: newLabel || 'SCIM Token' }),
            });
            if (!res.ok) throw new Error(t('generateFailed'));
            const data = await res.json();
            setNewTokenPlaintext(data.plaintext);
            setShowForm(false);
            setNewLabel('');
            fetchTokens();
        } catch (e) {
            setError(e instanceof Error ? e.message : t('failed'));
        } finally {
            setGenerating(false);
        }
    };

    const revokeToken = (tokenId: string) => setTokenIdToRevoke(tokenId);

    const performRevoke = async (tokenId: string) => {
        try {
            await fetch(apiUrl('/admin/scim'), {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tokenId }),
            });
            fetchTokens();
        } catch { /* ignore */ }
    };

    const copyToken = async () => {
        if (!newTokenPlaintext) return;
        const ok = await copy(newTokenPlaintext);
        if (ok) {
            toast.success(t('tokenCopied'));
        } else {
            toast.error(t('copyFailed'));
        }
    };

    const activeTokens = state?.tokens.filter(t => !t.revokedAt) || [];
    const revokedTokens = state?.tokens.filter(t => t.revokedAt) || [];

    return (
        <div className="space-y-section animate-fadeIn max-w-4xl">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <PageBreadcrumbs
                        items={[
                            { label: t('breadcrumbDashboard'), href: tenantHref('/dashboard') },
                            { label: t('breadcrumbAdmin'), href: tenantHref('/admin') },
                            { label: t('breadcrumbScim') },
                        ]}
                        className="mb-1"
                    />
                    <Heading level={1} className="flex items-center gap-tight">
                        <CloudCog className="w-6 h-6 text-[var(--brand-default)]" />
                        {t('heading')}
                    </Heading>
                    <p className="text-sm text-content-muted mt-1">
                        {t('description')}
                    </p>
                </div>
                <div className={`px-3 py-1 rounded-full text-xs font-medium ${
                    activeTokens.length > 0
                        ? 'bg-bg-success text-content-success border border-border-success'
                        : 'bg-bg-elevated/50 text-content-muted border border-border-emphasis'
                }`}>
                    {activeTokens.length > 0 ? t('enabled') : t('notConfigured')}
                </div>
            </div>

            {/* Endpoint Info — render the slot eagerly so #scim-endpoint-url
                is queryable before the GET /admin/scim fetch resolves. */}
            <div className={cardVariants({ density: 'compact' })}>
                <Heading level={3} className="mb-2">{t('scimEndpoint')}</Heading>
                <div className="flex items-center gap-tight bg-bg-default/50 rounded px-3 py-2">
                    <code
                        className="text-xs text-[var(--brand-muted)] flex-1 select-all min-h-[1.25rem] inline-block"
                        id="scim-endpoint-url"
                    >
                        {state?.scimEndpoint ?? (loading ? t('loadingEndpoint') : '—')}
                    </code>
                    <CopyButton
                        value={state?.scimEndpoint ?? ''}
                        label={t('copyEndpoint')}
                        successMessage={t('endpointCopied')}
                        size="sm"
                        disabled={!state?.scimEndpoint}
                    />
                    <ExternalLink className="w-3.5 h-3.5 text-content-subtle" />
                </div>
                <p className="text-xs text-content-subtle mt-1">
                    {t('endpointHelp')}
                </p>
            </div>

            {/* New Token Alert - Only shown once */}
            {newTokenPlaintext && (
                <InlineNotice
                    variant="warning"
                    icon={AlertTriangle}
                    id="new-token-alert"
                    title={t('copyTokenNow')}
                    className="flex-col items-stretch p-4"
                >
                    <p className="text-xs text-content-warning">
                        {t('tokenNotShownAgain')}
                    </p>
                    <div className="flex items-center gap-tight mt-3 bg-bg-page/60 rounded px-3 py-2">
                        <code className="text-xs text-content-emphasis flex-1 break-all select-all" id="scim-token-value">
                            {newTokenPlaintext}
                        </code>
                        <Button variant="secondary" size="sm" onClick={copyToken} className="shrink-0" id="copy-token-btn">
                            {copied ? <Check className="w-3.5 h-3.5 text-content-success" /> : <Copy className="w-3.5 h-3.5" />}
                            {copied ? t('copied') : t('copy')}
                        </Button>
                    </div>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setNewTokenPlaintext(null)}
                        className="mt-3 w-full"
                    >
                        {t('copiedTokenDismiss')}
                    </Button>
                </InlineNotice>
            )}

            {/* Token List */}
            <div className={cardVariants({ density: 'none' })}>
                <div className="flex items-center justify-between p-4 border-b border-border-default/50">
                    <Heading level={3}>{t('scimTokens')}</Heading>
                    <Button
                        variant="primary"
                        icon={<Plus />}
                        onClick={() => setShowForm(true)}
                        id="generate-token-btn"
                        disabled={generating}
                    >
                        {t('newTokenButton')}
                    </Button>
                </div>

                {/* Generate form */}
                {showForm && (
                    <div className="p-4 border-b border-border-default/50 bg-bg-default/30">
                        <div className="flex gap-tight">
                            <input
                                type="text"
                                value={newLabel}
                                onChange={e => setNewLabel(e.target.value)}
                                placeholder={t('tokenLabelPlaceholder')}
                                className="input flex-1"
                                id="token-label-input"
                                autoFocus
                            />
                            <Button variant="primary" size="sm" onClick={generateToken} disabled={generating} loading={generating}>
                                {generating ? t('generating') : t('create')}
                            </Button>
                            <Button variant="secondary" size="sm" onClick={() => setShowForm(false)}>
                                {t('cancel')}
                            </Button>
                        </div>
                    </div>
                )}

                {error && (
                    <div className="p-3 text-xs text-content-error bg-bg-error border-b border-border-error">
                        {error}
                    </div>
                )}

                {loading ? (
                    <div className="p-8 text-center text-content-subtle text-sm"><span className="animate-pulse">{t('fetchingTokens')}</span></div>
                ) : activeTokens.length === 0 && !showForm ? (
                    <div className="p-8 text-center">
                        <CloudCog className="w-8 h-8 text-content-subtle mx-auto mb-2" />
                        <p className="text-sm text-content-muted">{t('noActiveTokens')}</p>
                        <p className="text-xs text-content-subtle mt-1">
                            {t('noActiveTokensHelp')}
                        </p>
                    </div>
                ) : (
                    <div className="divide-y divide-border-default/50">
                        {activeTokens.map(token => (
                            <div key={token.id} className="flex items-center justify-between p-4">
                                <div>
                                    <div className="flex items-center gap-tight">
                                        <span className="text-sm font-medium text-content-emphasis">{token.label}</span>
                                        <StatusBadge variant="success" size="sm">{t('activeBadge')}</StatusBadge>
                                    </div>
                                    <div className="flex items-center gap-compact mt-1">
                                        <span className="text-xs text-content-subtle">
                                            {t('createdOn', { date: formatDate(token.createdAt) })}
                                        </span>
                                        {token.lastUsedAt && (
                                            <span className="text-xs text-content-muted flex items-center gap-1">
                                                <Clock className="w-3.5 h-3.5" />
                                                {t('lastUsedOn', { date: formatDate(token.lastUsedAt) })}
                                            </span>
                                        )}
                                    </div>
                                </div>
                                <Button
                                    variant="destructive-outline"
                                    size="sm"
                                    onClick={() => revokeToken(token.id)}
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                    {t('revoke')}
                                </Button>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Revoked tokens */}
            {revokedTokens.length > 0 && (
                <details className={cardVariants({ density: 'none' })}>
                    <summary className="p-4 cursor-pointer text-sm text-content-muted hover:text-content-default">
                        {t('revokedTokenCount', { count: revokedTokens.length })}
                    </summary>
                    <div className="divide-y divide-border-default/50 border-t border-border-default/50">
                        {revokedTokens.map(token => (
                            <div key={token.id} className="flex items-center justify-between p-4 opacity-50">
                                <div>
                                    <span className="text-sm text-content-muted">{token.label}</span>
                                    <StatusBadge variant="error" size="sm" className="ml-2">{t('revokedBadge')}</StatusBadge>
                                    <div className="text-xs text-content-subtle mt-1">
                                        {t('revokedOn', { date: formatDate(token.revokedAt!) })}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </details>
            )}

            {/* Setup guide */}
            <Card>
                <Heading level={3} className="mb-3">{t('setupGuide')}</Heading>
                <ol className="space-y-tight text-xs text-content-muted list-decimal list-inside">
                    <li>{t('guide1')}</li>
                    <li>{t('guide2')}</li>
                    <li>{t.rich('guide3', { strong: (c) => <strong>{c}</strong> })}</li>
                    <li>{t.rich('guide4', { strong: (c) => <strong>{c}</strong> })}</li>
                    <li>{t.rich('guide5', { em: (c) => <em>{c}</em> })}</li>
                    <li>{t('guide6')}</li>
                </ol>
                <div className="mt-4 p-3 bg-bg-default/50 rounded text-xs text-content-subtle">
                    {t.rich('roleMapping', {
                        strongMuted: (c) => <strong className="text-content-muted">{c}</strong>,
                        strong: (c) => <strong>{c}</strong>,
                    })}
                </div>
            </Card>
            <ConfirmDialog
                showModal={tokenIdToRevoke !== null}
                setShowModal={(open) => {
                    if (typeof open === 'function') {
                        const next = open(tokenIdToRevoke !== null);
                        if (!next) setTokenIdToRevoke(null);
                    } else if (!open) {
                        setTokenIdToRevoke(null);
                    }
                }}
                tone="danger"
                title={t('confirmRevokeTitle')}
                description={t('confirmRevokeDesc')}
                confirmLabel={t('confirmRevokeLabel')}
                onConfirm={async () => {
                    if (tokenIdToRevoke) await performRevoke(tokenIdToRevoke);
                }}
            />
        </div>
    );
}
