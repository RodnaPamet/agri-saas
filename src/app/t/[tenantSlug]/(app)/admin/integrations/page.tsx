'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/* eslint-disable @typescript-eslint/no-explicit-any -- Tanstack-react-table cell callbacks (tanstack cell callbacks where row/getValue carry the implicit-any annotation) — typing each callback with `CellContext<TData, TValue>` requires importing the right generic per column and adds significant ceremony. The implicit any here is at the render-time boundary; row.original is type-narrowed by the column's accessorKey at runtime. */
import { formatDate } from '@/lib/format-date';
import { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { Trash2, CheckCircle, XCircle, Loader2, Link2, Eye, EyeOff, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { RequiredMarker } from '@/components/ui/required-marker';
import { Tooltip } from '@/components/ui/tooltip';
import { DataTable, createColumns } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { SharePointCard } from './SharePointCard';

interface ConnectionDTO {
    id: string;
    provider: string;
    name: string;
    isEnabled: boolean;
    configJson: Record<string, unknown>;
    lastTestedAt: string | null;
    lastTestStatus: string | null;
    createdAt: string;
    updatedAt: string;
    secretStatus: string;
    webhookUrl: string;
    _count?: { executions: number };
}

interface ProviderInfo {
    id: string;
    displayName: string;
    description: string;
    supportedChecks: string[];
    configSchema: {
        configFields: { key: string; label: string; type: string; required: boolean; placeholder?: string; description?: string }[];
        secretFields: { key: string; label: string; type: string; required: boolean; placeholder?: string; description?: string }[];
    };
}

export default function AdminIntegrationsPage() {
    const t = useTranslations('admin.integrations');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();

    const [connections, setConnections] = useState<ConnectionDTO[]>([]);
    const [providers, setProviders] = useState<ProviderInfo[]>([]);
    const [webhookBaseUrl, setWebhookBaseUrl] = useState('');
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [formProvider, setFormProvider] = useState('');
    const [formName, setFormName] = useState('');
    const [formConfig, setFormConfig] = useState<Record<string, string>>({});
    const [formSecrets, setFormSecrets] = useState<Record<string, string>>({});
    const [showSecrets, setShowSecrets] = useState(false);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState<string | null>(null);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    const fetchConnections = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(apiUrl('/admin/integrations'));
            const data = await res.json();
            setConnections(data.connections ?? []);
            setProviders(data.availableProviders ?? []);
            setWebhookBaseUrl(data.webhookBaseUrl ?? '');
        } catch {
            setMessage({ type: 'error', text: t('loadFailed') });
        }
        setLoading(false);
    }, [apiUrl]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchConnections(); }, [fetchConnections]);

    const resetForm = () => {
        setShowForm(false);
        setEditingId(null);
        setFormProvider('');
        setFormName('');
        setFormConfig({});
        setFormSecrets({});
        setShowSecrets(false);
    };

    const handleSave = async () => {
        if (!formProvider || !formName) {
            setMessage({ type: 'error', text: t('providerNameRequired') });
            return;
        }
        setSaving(true);
        setMessage(null);
        try {
            const body: Record<string, unknown> = {
                provider: formProvider,
                name: formName,
                configJson: formConfig,
            };
            if (editingId) body.id = editingId;

            // Only send secrets if any field has a value
            const hasSecrets = Object.values(formSecrets).some(v => v.trim().length > 0);
            if (hasSecrets) {
                body.secrets = formSecrets;
            }

            const res = await fetch(apiUrl('/admin/integrations'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (!res.ok) {
                const err = await res.json();
                setMessage({ type: 'error', text: err.error || t('saveFailed') });
            } else {
                const data = await res.json();
                setMessage({
                    type: 'success',
                    text: editingId
                        ? t('connectionUpdated')
                        : `${t('connectionCreated')}${data.warning ? ` ${data.warning}` : ''}`,
                });
                resetForm();
                await fetchConnections();
            }
        } catch {
            setMessage({ type: 'error', text: t('networkError') });
        }
        setSaving(false);
    };

    const handleTest = async (conn: ConnectionDTO) => {
        setTesting(conn.id);
        setMessage(null);
        try {
            const res = await fetch(apiUrl('/admin/integrations'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    connectionId: conn.id,
                    provider: conn.provider,
                    configJson: conn.configJson,
                }),
            });
            const data = await res.json();
            setMessage({
                type: data.valid ? 'success' : 'error',
                text: data.valid ? t('testPassed') : t('testFailedError', { error: data.error || t('unknownError') }),
            });
            await fetchConnections();
        } catch {
            setMessage({ type: 'error', text: t('testFailedNetwork') });
        }
        setTesting(null);
    };

    const handleDisable = async (connectionId: string) => {
        setMessage(null);
        try {
            await fetch(apiUrl('/admin/integrations'), {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connectionId }),
            });
            setMessage({ type: 'success', text: t('connectionDisabled') });
            await fetchConnections();
        } catch {
            setMessage({ type: 'error', text: t('disableFailed') });
        }
    };

    const selectedProvider = providers.find(p => p.id === formProvider);

    return (
            <div className="space-y-section animate-fadeIn">
                <div>
                    <PageBreadcrumbs
                        items={[
                            { label: t('breadcrumbDashboard'), href: tenantHref('/dashboard') },
                            { label: t('breadcrumbAdmin'), href: tenantHref('/admin') },
                            { label: t('breadcrumbIntegrations') },
                        ]}
                        className="mb-1"
                    />
                    <Heading level={1}>{t('heading')}</Heading>
                </div>

                {/* SP-1 — SharePoint connection (delegated consent, separate
                    from the generic config-field connections below). */}
                <SharePointCard />

                {/* Message banner */}
                {message && (
                    <div className={`p-3 rounded-lg text-sm flex items-center gap-tight ${
                        message.type === 'success'
                            ? 'bg-bg-success border border-border-success text-content-success'
                            : 'bg-bg-error border border-border-error text-content-error'
                    }`}>
                        {message.type === 'success' ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                        {message.text}
                    </div>
                )}

                {/* Webhook endpoint info */}
                {webhookBaseUrl && (
                    <div className={cardVariants({ density: 'compact' })}>
                        <p className="text-xs text-content-muted mb-1">{t('webhookBaseUrl')}</p>
                        <code className="text-sm text-[var(--brand-default)] font-mono">{`${webhookBaseUrl}/{provider}`}</code>
                    </div>
                )}

                {/* Connections list. R13-PR6 — outer
                    `cardVariants({ density: 'none' })` wrapper
                    dropped so the DataTable primitive's own bordered
                    card is the only one (matches Practices list
                    visually). The "Configured Connections" heading +
                    Add button hoist above the table. */}
                <div>
                    <div className="flex justify-between items-center mb-3">
                        <Heading level={2}>{t('configuredConnections')}</Heading>
                        <Button
                            variant="primary"
                            icon={<Plus />}
                            onClick={() => { resetForm(); setShowForm(true); }}
                            id="add-integration-btn"
                        >
                            {t('addIntegrationButton')}
                        </Button>
                    </div>

                    {loading ? (
                        <div className="p-8 text-center text-content-subtle">
                            <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
                            <span className="sr-only">{t('fetchingIntegrations')}</span>
                        </div>
                    ) : connections.length === 0 ? (
                        <div className="p-8 text-center text-content-subtle">
                            {t('noIntegrations')}
                        </div>
                    ) : (
                        (() => {
                            const connCols = createColumns<ConnectionDTO>([
                                { accessorKey: 'provider', header: t('colProvider'), cell: ({ getValue }: any) => <StatusBadge variant="info">{getValue()}</StatusBadge> },
                                { accessorKey: 'name', header: t('colName'), cell: ({ getValue }: any) => <span className="font-medium">{getValue()}</span> },
                                {
                                    id: 'status', header: t('colStatus'), accessorKey: 'isEnabled',
                                    cell: ({ row }: any) => <StatusBadge variant={row.original.isEnabled ? 'success' : 'error'}>{row.original.isEnabled ? t('active') : t('disabled')}</StatusBadge>,
                                },
                                { id: 'secrets', header: t('colSecrets'), cell: () => <span className="text-content-subtle font-mono">••••••••</span> },
                                {
                                    id: 'lastTest', header: t('colLastTest'), accessorKey: 'lastTestedAt',
                                    cell: ({ row }: any) => row.original.lastTestedAt ? (
                                        <span className="flex items-center gap-1 text-content-muted">
                                            {row.original.lastTestStatus === 'ok' ? <CheckCircle className="w-3.5 h-3.5 text-content-success" /> : <XCircle className="w-3.5 h-3.5 text-content-error" />}
                                            {formatDate(row.original.lastTestedAt)}
                                        </span>
                                    ) : <span className="text-content-subtle">—</span>,
                                },
                                { id: 'executions', header: t('colExecutions'), accessorFn: (c: ConnectionDTO) => c._count?.executions ?? 0, cell: ({ getValue }: any) => <span>{getValue()}</span> },
                                {
                                    id: 'actions', header: t('colActions'),
                                    cell: ({ row }: any) => (
                                        <div className="flex gap-1">
                                            <Tooltip content={t('testConnection')}>
                                                <Button variant="secondary" size="xs" onClick={() => handleTest(row.original)} disabled={testing === row.original.id} aria-label={t('testConnection')}>
                                                    {testing === row.original.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
                                                </Button>
                                            </Tooltip>
                                            <Tooltip content={t('disableIntegration')}>
                                                <Button variant="destructive-outline" size="xs" onClick={() => handleDisable(row.original.id)} aria-label={t('disableIntegration')}>
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                </Button>
                                            </Tooltip>
                                        </div>
                                    ),
                                },
                            ]);
                            return (
                                <DataTable
                                    data={connections}
                                    columns={connCols}
                                    getRowId={(c) => c.id}
                                    emptyState={t('noIntegrations')}
                                    resourceName={(p) => p ? t('connectionsPlural') : t('connectionSingular')}
                                    data-testid="integrations-table"
                                />
                            );
                        })()
                    )}
                </div>

                {/* Add/Edit Form */}
                {showForm && (
                    <div className={cn(cardVariants(), 'space-y-default')}>
                        <Heading level={2}>
                            {editingId ? t('editIntegration') : t('addIntegrationForm')}
                        </Heading>

                        {/* Provider select */}
                        <div>
                            <label className="block text-sm text-content-muted mb-1">{t('provider')}</label>
                            <Combobox
                                id="integration-provider-select"
                                selected={providers.map(p => ({ value: p.id, label: p.displayName })).find(o => o.value === formProvider) ?? null}
                                setSelected={(opt) => { setFormProvider(opt?.value ?? ''); setFormConfig({}); setFormSecrets({}); }}
                                options={providers.map(p => ({ value: p.id, label: p.displayName }))}
                                placeholder={t('selectProvider')}
                                disabled={!!editingId}
                                matchTriggerWidth
                            />
                            {selectedProvider && (
                                <p className="text-xs text-content-subtle mt-1">{selectedProvider.description}</p>
                            )}
                        </div>

                        {/* Name */}
                        <div>
                            <label className="block text-sm text-content-muted mb-1">{t('connectionName')}</label>
                            <input
                                type="text"
                                value={formName}
                                onChange={e => setFormName(e.target.value)}
                                className="input w-full"
                                placeholder={t('connectionNamePlaceholder')}
                                id="integration-name-input"
                            />
                        </div>

                        {/* Config fields */}
                        {selectedProvider && selectedProvider.configSchema.configFields.length > 0 && (
                            <div className="space-y-compact">
                                <Heading level={3}>{t('configuration')}</Heading>
                                {selectedProvider.configSchema.configFields.map(field => (
                                    <div key={field.key}>
                                        <label className="block text-xs text-content-muted mb-1">
                                            {field.label} {field.required && <RequiredMarker />}
                                        </label>
                                        <input
                                            type="text"
                                            value={formConfig[field.key] ?? ''}
                                            onChange={e => setFormConfig(prev => ({ ...prev, [field.key]: e.target.value }))}
                                            className="input w-full"
                                            placeholder={field.placeholder}
                                        />
                                        {field.description && (
                                            <p className="text-xs text-content-subtle mt-0.5">{field.description}</p>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Secret fields */}
                        {selectedProvider && selectedProvider.configSchema.secretFields.length > 0 && (
                            <div className="space-y-compact">
                                <div className="flex items-center justify-between">
                                    <Heading level={3}>{t('secrets')}</Heading>
                                    <Button
                                        variant="secondary"
                                        size="xs"
                                        onClick={() => setShowSecrets(!showSecrets)}
                                    >
                                        {showSecrets ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                        {showSecrets ? t('hide') : t('show')}
                                    </Button>
                                </div>
                                <div className="p-3 rounded border border-border-warning bg-bg-warning">
                                    <p className="text-xs text-content-warning">
                                        {t('secretsEncrypted')}
                                    </p>
                                </div>
                                {selectedProvider.configSchema.secretFields.map(field => (
                                    <div key={field.key}>
                                        <label className="block text-xs text-content-muted mb-1">
                                            {field.label} {field.required && <RequiredMarker />}
                                        </label>
                                        <input
                                            type={showSecrets ? 'text' : 'password'}
                                            value={formSecrets[field.key] ?? ''}
                                            onChange={e => setFormSecrets(prev => ({ ...prev, [field.key]: e.target.value }))}
                                            className="input w-full font-mono"
                                            placeholder={field.placeholder ?? '••••••••'}
                                            autoComplete="off"
                                        />
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Supported checks */}
                        {selectedProvider && (
                            <div>
                                <Heading level={3} className="mb-1">{t('supportedChecks')}</Heading>
                                <div className="flex flex-wrap gap-1">
                                    {selectedProvider.supportedChecks.map(check => (
                                        <StatusBadge variant="neutral" key={check}>
                                            {selectedProvider.id}.{check}
                                        </StatusBadge>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Actions */}
                        <div className="flex gap-tight pt-2">
                            <Button
                                variant="primary"
                                onClick={handleSave}
                                disabled={saving || !formProvider || !formName}
                                loading={saving}
                                id="save-integration-btn"
                            >
                                {editingId ? t('updateConnection') : t('createConnection')}
                            </Button>
                            <Button variant="secondary" onClick={resetForm}>{t('cancel')}</Button>
                        </div>
                    </div>
                )}
            </div>
    );
}
