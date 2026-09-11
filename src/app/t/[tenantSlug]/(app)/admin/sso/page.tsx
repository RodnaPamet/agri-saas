'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Card, cardVariants } from '@/components/ui/card';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { Shield, ExternalLink, Trash2, Save, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { InfoTooltip } from '@/components/ui/tooltip';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { cn } from '@/lib/cn';

interface SsoProvider {
    id: string;
    type: 'SAML' | 'OIDC';
    name: string;
    isEnabled: boolean;
    isEnforced: boolean;
    emailDomains: string[];
    configJson: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
}

type Tab = 'OIDC' | 'SAML';

// Hoisted to module scope to satisfy react-hooks/static-components.
// Was previously declared inside `SsoAdminPage` and closed over
// `existingProvider`; now takes it as a prop.
function ProviderStatusBadge({ existingProvider }: { existingProvider: SsoProvider | null | undefined }) {
    const t = useTranslations('admin.sso');
    if (!existingProvider) {
        return <StatusBadge variant="neutral">{t('notConfigured')}</StatusBadge>;
    }
    if (existingProvider.isEnforced) {
        return <StatusBadge variant="warning">{t('enforced')}</StatusBadge>;
    }
    if (existingProvider.isEnabled) {
        return <StatusBadge variant="info">{t('enabled')}</StatusBadge>;
    }
    return <StatusBadge variant="error">{t('disabled')}</StatusBadge>;
}

export default function SsoAdminPage() {
    const t = useTranslations('admin.sso');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const [providers, setProviders] = useState<SsoProvider[]>([]);
    const [tab, setTab] = useState<Tab>('OIDC');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

    // ── Form state ──
    const [formName, setFormName] = useState('');
    const [formEmailDomains, setFormEmailDomains] = useState('');
    const [formEnabled, setFormEnabled] = useState(false);
    const [formEnforced, setFormEnforced] = useState(false);
    const [showSecret, setShowSecret] = useState(false);

    // OIDC fields
    const [oidcIssuer, setOidcIssuer] = useState('');
    const [oidcClientId, setOidcClientId] = useState('');
    const [oidcClientSecret, setOidcClientSecret] = useState('');
    const [oidcScopes, setOidcScopes] = useState('openid email profile');

    // SAML fields
    const [samlEntityId, setSamlEntityId] = useState('');
    const [samlSsoUrl, setSamlSsoUrl] = useState('');
    const [samlCertificate, setSamlCertificate] = useState('');
    const [samlNameIdFormat, setSamlNameIdFormat] = useState('');

    const fetchProviders = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/sso'));
            if (res.ok) {
                const data = await res.json();
                setProviders(data);
            }
        } catch {
            // Silently fail on fetch errors
        } finally {
            setLoading(false);
        }
    }, [apiUrl]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchProviders(); }, [fetchProviders]);

    // ── Load existing provider into form ──
    const existingProvider = providers.find((p) => p.type === tab);

    useEffect(() => {
        if (existingProvider) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setFormName(existingProvider.name);
            setFormEmailDomains(existingProvider.emailDomains.join(', '));
            setFormEnabled(existingProvider.isEnabled);
            setFormEnforced(existingProvider.isEnforced);
            const config = existingProvider.configJson;
            if (existingProvider.type === 'OIDC') {
                setOidcIssuer((config.issuer as string) || '');
                setOidcClientId((config.clientId as string) || '');
                setOidcClientSecret((config.clientSecret as string) || '');
                setOidcScopes(Array.isArray(config.scopes)
                    ? (config.scopes as string[]).join(' ')
                    : 'openid email profile');
            } else {
                setSamlEntityId((config.entityId as string) || '');
                setSamlSsoUrl((config.ssoUrl as string) || '');
                setSamlCertificate((config.certificate as string) || '');
                setSamlNameIdFormat((config.nameIdFormat as string) || '');
            }
        } else {
            resetForm();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab, existingProvider?.id]);

    function resetForm() {
        setFormName('');
        setFormEmailDomains('');
        setFormEnabled(false);
        setFormEnforced(false);
        setOidcIssuer('');
        setOidcClientId('');
        setOidcClientSecret('');
        setOidcScopes('openid email profile');
        setSamlEntityId('');
        setSamlSsoUrl('');
        setSamlCertificate('');
        setSamlNameIdFormat('');
    }

    // ── Save handler ──
    async function handleSave() {
        setError(null);
        setSuccess(null);
        setSaving(true);

        const emailDomains = formEmailDomains
            .split(/[,\s]+/)
            .map((d) => d.trim().toLowerCase())
            .filter(Boolean);

        const config = tab === 'OIDC'
            ? {
                issuer: oidcIssuer,
                clientId: oidcClientId,
                // Don't send masked value back
                ...(oidcClientSecret !== '••••••••' && { clientSecret: oidcClientSecret }),
                ...(existingProvider && oidcClientSecret === '••••••••' && {
                    clientSecret: (existingProvider.configJson as Record<string, string>).clientSecret,
                }),
                scopes: oidcScopes.split(/\s+/).filter(Boolean),
            }
            : {
                entityId: samlEntityId,
                ssoUrl: samlSsoUrl,
                ...(samlCertificate !== '••••••••' && { certificate: samlCertificate }),
                ...(existingProvider && samlCertificate === '••••••••' && {
                    certificate: (existingProvider.configJson as Record<string, string>).certificate,
                }),
                ...(samlNameIdFormat && { nameIdFormat: samlNameIdFormat }),
            };

        try {
            const res = await fetch(apiUrl('/sso'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: existingProvider?.id,
                    name: formName || t('providerNameDefault', { tab }),
                    type: tab,
                    isEnabled: formEnabled,
                    isEnforced: formEnforced,
                    emailDomains,
                    config,
                }),
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: t('unknownError') }));
                setError(err.error || err.message || t('saveFailed'));
                return;
            }

            setSuccess(t('configSaved'));
            await fetchProviders();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setSaving(false);
        }
    }

    // ── Delete handler ──
    function handleDelete() {
        if (!existingProvider) return;
        setShowDeleteConfirm(true);
    }

    async function performDelete() {
        if (!existingProvider) return;
        setError(null);
        try {
            const res = await fetch(apiUrl('/sso'), {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: existingProvider.id }),
            });
            if (res.ok) {
                resetForm();
                await fetchProviders();
                setSuccess(t('configDeleted'));
            }
        } catch (err) {
            setError((err as Error).message);
        }
    }

    // StatusBadge hoisted to module scope (above) — see comment there.

    function testLoginUrl() {
        if (!existingProvider) return null;
        const tenantSlug = window.location.pathname.split('/')[2];
        const protocol = tab.toLowerCase();
        return `/api/auth/sso/${protocol}/start?tenant=${tenantSlug}&provider=${existingProvider.id}&returnTo=${window.location.pathname}`;
    }

    if (loading) {
        return (
            <div className="space-y-section animate-fadeIn">
                <PageBreadcrumbs
                    items={[
                        { label: t('breadcrumbDashboard'), href: tenantHref('/dashboard') },
                        { label: t('breadcrumbAdmin'), href: tenantHref('/admin') },
                        { label: t('breadcrumbSso') },
                    ]}
                    className="mb-1"
                />
                <Heading level={2}>{t('loading')}</Heading>
                <Card className="space-y-default">
                    <div className="h-4 bg-bg-elevated/60 rounded w-1/3 animate-pulse" />
                    <div className="h-4 bg-bg-elevated/60 rounded w-2/3 animate-pulse" />
                    <div className="h-4 bg-bg-elevated/60 rounded w-1/2 animate-pulse" />
                </Card>
            </div>
        );
    }

    return (
        <div className="space-y-section animate-fadeIn">
            {/* Header */}
            <div>
                <PageBreadcrumbs
                    items={[
                        { label: t('breadcrumbDashboard'), href: tenantHref('/dashboard') },
                        { label: t('breadcrumbAdmin'), href: tenantHref('/admin') },
                        { label: t('breadcrumbSso') },
                    ]}
                    className="mb-1"
                />
                <Heading level={1} className="flex items-center gap-tight">
                    <Shield className="w-6 h-6 text-[var(--brand-default)]" />
                    {t('heading')}
                </Heading>
                <p className="text-sm text-content-muted mt-1">
                    {t('description')}
                </p>
            </div>

            {/* Protocol tabs — Epic 60 ToggleGroup. `id` on each option
                preserves `#sso-tab-oidc` / `#sso-tab-saml` DOM anchors
                for any future E2E selector use. */}
            <div className="flex items-center gap-tight">
                <ToggleGroup
                    ariaLabel={t('protocolLabel')}
                    options={[
                        { value: 'OIDC', label: 'OIDC', id: 'sso-tab-oidc' },
                        { value: 'SAML', label: t('saml2'), id: 'sso-tab-saml' },
                    ]}
                    selected={tab}
                    selectAction={(v) => setTab(v as 'OIDC' | 'SAML')}
                />
                <div className="ml-auto">
                    <ProviderStatusBadge existingProvider={existingProvider} />
                </div>
            </div>

            {/* Messages */}
            {error && (
                <InlineNotice variant="error" id="sso-error">{error}</InlineNotice>
            )}
            {success && (
                <InlineNotice variant="success" id="sso-success">{success}</InlineNotice>
            )}

            {/* Config form */}
            <div className={cardVariants()}>
                <Heading level={2} className="mb-4">{t('configTitle', { tab })}</Heading>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-default">
                    {/* Provider name */}
                    <div>
                        <label className="text-xs text-content-muted uppercase tracking-wider mb-1 block">
                            {t('providerName')}
                        </label>
                        <input
                            id="sso-name"
                            value={formName}
                            onChange={(e) => setFormName(e.target.value)}
                            placeholder={tab === 'OIDC' ? t('providerNamePlaceholderOidc') : t('providerNamePlaceholderSaml')}
                            className="input w-full"
                        />
                    </div>

                    {/* Email domains */}
                    <div>
                        <label className="text-xs text-content-muted uppercase tracking-wider mb-1 block">
                            {t('emailDomains')}
                        </label>
                        <input
                            id="sso-domains"
                            value={formEmailDomains}
                            onChange={(e) => setFormEmailDomains(e.target.value)}
                            placeholder={t('emailDomainsPlaceholder')}
                            className="input w-full"
                        />
                        <span className="text-xs text-content-subtle mt-0.5">{t('commaSeparated')}</span>
                    </div>
                </div>

                {/* Protocol-specific fields */}
                {tab === 'OIDC' ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-default mt-4">
                        <div>
                            <label className="text-xs text-content-muted uppercase tracking-wider mb-1 block">{t('issuerUrl')}</label>
                            <input
                                id="sso-oidc-issuer"
                                value={oidcIssuer}
                                onChange={(e) => setOidcIssuer(e.target.value)}
                                placeholder={t('issuerUrlPlaceholder')}
                                className="input w-full"
                            />
                        </div>
                        <div>
                            <label className="text-xs text-content-muted uppercase tracking-wider mb-1 block">{t('clientId')}</label>
                            <input
                                id="sso-oidc-client-id"
                                value={oidcClientId}
                                onChange={(e) => setOidcClientId(e.target.value)}
                                placeholder={t('clientIdPlaceholder')}
                                className="input w-full"
                            />
                        </div>
                        <div>
                            <label className="text-xs text-content-muted uppercase tracking-wider mb-1 block">{t('clientSecret')}</label>
                            <div className="relative">
                                <input
                                    id="sso-oidc-client-secret"
                                    type={showSecret ? 'text' : 'password'}
                                    value={oidcClientSecret}
                                    onChange={(e) => setOidcClientSecret(e.target.value)}
                                    placeholder={t('clientSecretPlaceholder')}
                                    className="input w-full pr-10"
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowSecret(!showSecret)}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-content-muted hover:text-content-emphasis"
                                >
                                    {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                </button>
                            </div>
                        </div>
                        <div>
                            <label className="text-xs text-content-muted uppercase tracking-wider mb-1 block">{t('scopes')}</label>
                            <input
                                id="sso-oidc-scopes"
                                value={oidcScopes}
                                onChange={(e) => setOidcScopes(e.target.value)}
                                placeholder={t('scopesPlaceholder')}
                                className="input w-full"
                            />
                        </div>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-default mt-4">
                        <div>
                            <label className="text-xs text-content-muted uppercase tracking-wider mb-1 block">{t('idpEntityId')}</label>
                            <input
                                id="sso-saml-entity-id"
                                value={samlEntityId}
                                onChange={(e) => setSamlEntityId(e.target.value)}
                                placeholder={t('idpEntityIdPlaceholder')}
                                className="input w-full"
                            />
                        </div>
                        <div>
                            <label className="text-xs text-content-muted uppercase tracking-wider mb-1 block">{t('ssoUrl')}</label>
                            <input
                                id="sso-saml-sso-url"
                                value={samlSsoUrl}
                                onChange={(e) => setSamlSsoUrl(e.target.value)}
                                placeholder={t('ssoUrlPlaceholder')}
                                className="input w-full"
                            />
                        </div>
                        <div className="md:col-span-2">
                            <label className="text-xs text-content-muted uppercase tracking-wider mb-1 block">{t('x509Certificate')}</label>
                            <textarea
                                id="sso-saml-certificate"
                                value={samlCertificate}
                                onChange={(e) => setSamlCertificate(e.target.value)}
                                placeholder={t('certificatePlaceholder')}
                                rows={3}
                                className="input w-full font-mono text-base md:text-xs"
                            />
                        </div>
                        <div>
                            <div className="mb-1 flex items-center gap-1.5">
                                <label className="text-xs text-content-muted uppercase tracking-wider">{t('nameIdFormat')}</label>
                                <InfoTooltip
                                    aria-label={t('nameIdFormatAbout')}
                                    iconClassName="h-3.5 w-3.5"
                                    content={t('nameIdFormatTooltip')}
                                />
                            </div>
                            <input
                                id="sso-saml-nameid"
                                value={samlNameIdFormat}
                                onChange={(e) => setSamlNameIdFormat(e.target.value)}
                                placeholder={t('nameIdFormatPlaceholder')}
                                className="input w-full text-base md:text-xs"
                            />
                        </div>
                        <div>
                            <label className="text-xs text-content-muted uppercase tracking-wider mb-1 block">{t('acsUrl')}</label>
                            <input
                                readOnly
                                value={typeof window !== 'undefined'
                                    ? `${window.location.origin}/api/auth/sso/saml/callback`
                                    : '/api/auth/sso/saml/callback'}
                                className="input w-full text-base md:text-xs text-content-subtle cursor-not-allowed"
                            />
                        </div>
                    </div>
                )}

                {/* Toggles */}
                <div className="flex items-center gap-section mt-6 pt-4 border-t border-border-default/50">
                    <label className="flex items-center gap-tight cursor-pointer">
                        <input
                            type="checkbox"
                            checked={formEnabled}
                            onChange={(e) => setFormEnabled(e.target.checked)}
                            className="accent-[var(--brand-default)]"
                            id="sso-enabled"
                        />
                        <span className="text-sm text-content-emphasis">{t('enableSso')}</span>
                    </label>
                    <label className="flex items-center gap-tight cursor-pointer">
                        <input
                            type="checkbox"
                            checked={formEnforced}
                            onChange={(e) => setFormEnforced(e.target.checked)}
                            className="accent-amber-500"
                            id="sso-enforced"
                        />
                        <span className="text-sm text-content-emphasis">{t('enforceSso')}</span>
                        <span className="text-xs text-content-subtle">{t('disablesLocalLogin')}</span>
                        <InfoTooltip
                            aria-label={t('enforceAbout')}
                            iconClassName="h-3.5 w-3.5"
                            content={t('enforceTooltip')}
                        />
                    </label>
                </div>

                {formEnforced && (
                    <InlineNotice variant="warning" className="mt-3">
                        {t('enforcedNotice')}
                    </InlineNotice>
                )}

                {/* Actions */}
                <div className="flex items-center gap-tight mt-6">
                    <Button
                        variant="primary"
                        onClick={handleSave}
                        disabled={saving}
                        loading={saving}
                        id="sso-save-btn"
                    >
                        <Save className="w-3.5 h-3.5" />
                        {saving ? t('savingConfig') : t('saveConfig')}
                    </Button>

                    {existingProvider && existingProvider.isEnabled && (
                        <a
                            href={testLoginUrl() || '#'}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={buttonVariants({ variant: 'secondary' })}
                            id="sso-test-btn"
                        >
                            <ExternalLink className="w-3.5 h-3.5" />
                            {t('testLogin')}
                        </a>
                    )}

                    {existingProvider && (
                        <Button
                            variant="destructive-outline"
                            onClick={handleDelete}
                            className="ml-auto"
                            id="sso-delete-btn"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                            {t('delete')}
                        </Button>
                    )}
                </div>
            </div>

            {/* Info card */}
            <div className={cn(cardVariants({ density: 'compact' }), 'border border-border-default/50')}>
                <Heading level={3} className="mb-2">{t('howItWorks')}</Heading>
                <ul className="text-xs text-content-muted space-y-1.5">
                    <li>{t('howItWorks1')}</li>
                    <li>{t('howItWorks2')}</li>
                    <li>{t('howItWorks3')}</li>
                    <li>{t('howItWorks4')}</li>
                </ul>
            </div>
            <ConfirmDialog
                showModal={showDeleteConfirm}
                setShowModal={setShowDeleteConfirm}
                tone="danger"
                title={t('confirmDeleteTitle')}
                description={t('confirmDeleteDesc')}
                confirmLabel={t('confirmDeleteLabel')}
                onConfirm={performDelete}
            />
        </div>
    );
}
