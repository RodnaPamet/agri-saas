'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Card, cardVariants } from '@/components/ui/card';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import {
    KeyRound, Trash2, Copy, Check,
    Clock, AlertTriangle, Eye, EyeOff, Plus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Combobox, ComboboxOption } from '@/components/ui/combobox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InfoTooltip, Tooltip } from '@/components/ui/tooltip';
import { useCopyToClipboard } from '@/components/ui/hooks';
import { DataTable, createColumns, useBulkDelete } from '@/components/ui/table';
import { InlineNotice } from '@/components/ui/inline-notice';
import { formatDateTime } from '@/lib/format-date';
import { useToast } from '@/components/ui/hooks/use-toast';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { cn } from '@/lib/cn';

// ─── Types ───

interface ApiKeyRecord {
    id: string;
    name: string;
    keyPrefix: string;
    scopes: string[];
    expiresAt: string | null;
    revokedAt: string | null;
    lastUsedAt: string | null;
    lastUsedIp: string | null;
    createdById: string;
    createdAt: string;
    createdBy: { id: string; name: string | null; email: string };
}

interface CreatedKeyResponse extends ApiKeyRecord {
    plaintext: string;
}

// ─── Scope Categories for UI Grouping ───

const SCOPE_GROUPS: Record<string, { label: string; scopes: string[] }> = {
    controls:   { label: 'Controls',   scopes: ['controls:read', 'controls:write'] },
    evidence:   { label: 'Evidence',   scopes: ['evidence:read', 'evidence:write'] },
    policies:   { label: 'Policies',   scopes: ['policies:read', 'policies:write', 'policies:admin'] },
    tasks:      { label: 'Tasks',      scopes: ['tasks:read', 'tasks:write'] },
    vendors:    { label: 'Vendors',    scopes: ['vendors:read', 'vendors:write'] },
    tests:      { label: 'Tests',      scopes: ['tests:read', 'tests:write'] },
    frameworks: { label: 'Frameworks', scopes: ['frameworks:read', 'frameworks:write'] },
    audits:     { label: 'Audits',     scopes: ['audits:read', 'audits:write'] },
    reports:    { label: 'Reports',    scopes: ['reports:read', 'reports:write'] },
    admin:      { label: 'Admin',      scopes: ['admin:read', 'admin:write'] },
};

const EXPIRY_OPTIONS = [
    { label: 'No expiry', value: '' },
    { label: '30 days', value: '30' },
    { label: '90 days', value: '90' },
    { label: '180 days', value: '180' },
    { label: '1 year', value: '365' },
];
const EXPIRY_CB_OPTIONS: ComboboxOption[] = EXPIRY_OPTIONS.filter(o => o.value).map(o => ({ value: o.value, label: o.label }));

function isExpired(expiresAt: string | null): boolean {
    if (!expiresAt) return false;
    return new Date(expiresAt) < new Date();
}

// ─── Scope Picker Component ───

function ScopePicker({
    selected,
    onChange,
}: {
    selected: string[];
    onChange: (scopes: string[]) => void;
}) {
    const t = useTranslations('admin.apiKeys');
    const isFullAccess = selected.includes('*');

    const toggleFullAccess = () => {
        if (isFullAccess) {
            onChange([]);
        } else {
            onChange(['*']);
        }
    };

    const toggleScope = (scope: string) => {
        if (isFullAccess) return;
        if (selected.includes(scope)) {
            onChange(selected.filter(s => s !== scope));
        } else {
            onChange([...selected, scope]);
        }
    };

    return (
        <div className="space-y-compact">
            <div className="flex items-center gap-tight">
                <button
                    type="button"
                    onClick={toggleFullAccess}
                    className={`text-xs px-3 py-1.5 rounded-md transition font-medium ${
                        isFullAccess
                            ? 'bg-bg-warning text-content-warning border border-border-warning'
                            : 'bg-bg-elevated/50 text-content-muted border border-border-emphasis/50 hover:border-border-emphasis'
                    }`}
                    id="scope-full-access"
                >
                    {t('fullAccess')}
                </button>
                <InfoTooltip
                    aria-label={t('fullAccessAbout')}
                    iconClassName="h-3.5 w-3.5"
                    content={t('fullAccessTooltip')}
                />
                {isFullAccess && (
                    <span className="text-[10px] text-content-warning flex items-center gap-1">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        {t('grantsAllPermissions')}
                    </span>
                )}
            </div>

            {!isFullAccess && (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-tight">
                    {Object.entries(SCOPE_GROUPS).map(([groupKey, group]) => (
                        <div key={group.label} className="bg-bg-default/40 rounded-lg p-2 space-y-1">
                            <div className="text-[10px] text-content-subtle uppercase tracking-wider font-medium">
                                {t(`scopes.${groupKey}`)}
                            </div>
                            {group.scopes.map((scope) => {
                                const action = scope.split(':')[1];
                                const isSelected = selected.includes(scope);
                                return (
                                    <button
                                        key={scope}
                                        type="button"
                                        onClick={() => toggleScope(scope)}
                                        className={`
                                            w-full text-left text-[11px] px-2 py-1 rounded transition
                                            ${isSelected
                                                ? 'bg-[var(--brand-subtle)] text-[var(--brand-muted)] border border-[var(--brand-default)]/40'
                                                : 'bg-bg-elevated/30 text-content-muted border border-transparent hover:border-border-emphasis'
                                            }
                                        `}
                                        id={`scope-${scope.replace(':', '-')}`}
                                    >
                                        <span className="capitalize">{action}</span>
                                        {isSelected && <Check className="w-3.5 h-3.5 inline ml-1" />}
                                    </button>
                                );
                            })}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ─── Copy-Once Key Display ───

export function KeyDisplay({ plaintext }: { plaintext: string }) {
    const t = useTranslations('admin.apiKeys');
    const [visible, setVisible] = useState(false);
    const { copy, copied } = useCopyToClipboard({ timeout: 2500 });
    const toast = useToast();

    const handleCopy = async () => {
        const ok = await copy(plaintext);
        if (ok) {
            toast.success(t('keyCopied'));
        } else {
            toast.error(t('keyCopyFailed'));
        }
    };

    return (
        <InlineNotice
            variant="warning"
            id="key-display"
            icon={AlertTriangle}
            title={t('copyKeyNow')}
            className="flex-col items-stretch space-y-tight p-4"
        >
            <div className="flex items-center gap-tight">
                <code className="flex-1 bg-bg-page px-3 py-2 rounded text-sm font-mono text-content-success select-all break-all">
                    {visible ? plaintext : plaintext.slice(0, 13) + '•'.repeat(40)}
                </code>
                <Tooltip content={visible ? t('hideKey') : t('showKey')}>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setVisible(!visible)}
                        aria-label={visible ? t('hideKey') : t('showKey')}
                        id="key-toggle-visibility"
                    >
                        {visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </Button>
                </Tooltip>
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleCopy}
                    id="key-copy-btn"
                >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? t('copiedExclaim') : t('copy')}
                </Button>
            </div>
        </InlineNotice>
    );
}

// ─── Main Page ───

export default function ApiKeysPage() {
    const t = useTranslations('admin.apiKeys');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();

    const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    // Create form
    const [showCreate, setShowCreate] = useState(false);
    const [createName, setCreateName] = useState('');
    const [createScopes, setCreateScopes] = useState<string[]>([]);
    const [createExpiry, setCreateExpiry] = useState('');
    const [creating, setCreating] = useState(false);
    const [createdKey, setCreatedKey] = useState<CreatedKeyResponse | null>(null);
    // Pending revocation — drives the ConfirmDialog. Replaces the
    // previous window.confirm() call.
    const [keyToRevoke, setKeyToRevoke] = useState<ApiKeyRecord | null>(null);

    // ─── Data Fetching ───
    const fetchKeys = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/admin/api-keys'));
            if (res.ok) setKeys(await res.json());
        } catch {
            setError(t('loadFailed'));
        } finally {
            setLoading(false);
        }
    }, [apiUrl]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchKeys(); }, [fetchKeys]);

    // ─── Create ───
    async function handleCreate() {
        setError(null);
        setSuccess(null);
        setCreating(true);

        try {
            let expiresAt: string | null = null;
            if (createExpiry) {
                const date = new Date();
                date.setDate(date.getDate() + parseInt(createExpiry));
                expiresAt = date.toISOString();
            }

            const res = await fetch(apiUrl('/admin/api-keys'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: createName.trim(),
                    scopes: createScopes,
                    expiresAt,
                }),
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: t('createFailed') }));
                setError(err.error?.message || err.error || err.message || t('createFailed'));
                return;
            }

            const result = await res.json();
            setCreatedKey(result);
            setSuccess(t('createdSuccess', { name: createName }));
            setCreateName('');
            setCreateScopes([]);
            setCreateExpiry('');
            setShowCreate(false);
            await fetchKeys();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setCreating(false);
        }
    }

    // ─── Revoke ───
    // The button in each row sets `keyToRevoke`; the actual delete
    // happens in the ConfirmDialog's `onConfirm` below.
    function handleRevoke(key: ApiKeyRecord) {
        setKeyToRevoke(key);
    }

    async function performRevoke(key: ApiKeyRecord) {
        setError(null);
        setSuccess(null);
        try {
            const res = await fetch(apiUrl(`/admin/api-keys/${key.id}`), { method: 'DELETE' });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: t('revokeFailed') }));
                setError(err.error?.message || err.error || t('revokeFailed'));
                throw new Error(err.error?.message || err.error || t('revokeFailed'));
            }
            setSuccess(t('revokedSuccess', { name: key.name }));
            await fetchKeys();
        } catch (err) {
            setError((err as Error).message);
            throw err;
        }
    }

    // ─── Partition keys ───
    const activeKeys = keys.filter(k => !k.revokedAt && !isExpired(k.expiresAt));
    const inactiveKeys = keys.filter(k => k.revokedAt || isExpired(k.expiresAt));

    // ─── Bulk revoke (selection action-row) ───
    const { batchAction: bulkRevokeAction, dialog: bulkRevokeDialog } =
        useBulkDelete<ApiKeyRecord>({
            entitySingular: t('apiKeySingular'),
            entityPlural: t('apiKeyPlural'),
            verb: 'Revoke',
            onDelete: async (ids) => {
                setError(null);
                setSuccess(null);
                const res = await fetch(apiUrl('/admin/api-keys/bulk/delete'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ apiKeyIds: ids }),
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({ error: t('revokeFailed') }));
                    const msg = err.error?.message || err.error || t('revokeFailed');
                    setError(msg);
                    throw new Error(msg);
                }
                const { revoked } = await res.json();
                setSuccess(t('revokedCount', { count: revoked }));
                await fetchKeys();
            },
        });

    // ─── Epic 52 — DataTable columns ───
    const activeKeyColumns = useMemo(
        () =>
            createColumns<ApiKeyRecord>([
                {
                    accessorKey: 'name',
                    header: t('colName'),
                    cell: ({ row }) => (
                        <span className="text-sm font-medium text-content-emphasis">{row.original.name}</span>
                    ),
                },
                {
                    accessorKey: 'keyPrefix',
                    header: t('colKey'),
                    cell: ({ row }) => (
                        <code className="text-content-muted font-mono">{row.original.keyPrefix}...</code>
                    ),
                },
                {
                    accessorKey: 'scopes',
                    header: t('colScopes'),
                    cell: ({ row }) => {
                        const scopes = row.original.scopes as string[];
                        return (
                            <div className="flex flex-wrap gap-1">
                                {scopes.slice(0, 3).map((s) => (
                                    <StatusBadge variant="info" size="sm" key={s}>{s}</StatusBadge>
                                ))}
                                {scopes.length > 3 && (
                                    <StatusBadge variant="neutral" size="sm">+{scopes.length - 3}</StatusBadge>
                                )}
                            </div>
                        );
                    },
                },
                {
                    accessorKey: 'expiresAt',
                    header: t('colExpires'),
                    cell: ({ row }) =>
                        row.original.expiresAt ? (
                            <span className="flex items-center gap-1 text-content-muted">
                                <Clock className="w-3.5 h-3.5" />
                                {formatDateTime(row.original.expiresAt)}
                            </span>
                        ) : (
                            <span className="text-content-subtle">{t('never')}</span>
                        ),
                },
                {
                    accessorKey: 'lastUsedAt',
                    header: t('colLastUsed'),
                    cell: ({ row }) => (
                        <span className="text-content-muted">{formatDateTime(row.original.lastUsedAt)}</span>
                    ),
                },
                {
                    accessorKey: 'createdAt',
                    header: t('colCreated'),
                    cell: ({ row }) => (
                        <span className="text-content-subtle">
                            {formatDateTime(row.original.createdAt)}
                            <br />
                            <span className="text-content-subtle">
                                {t('byUser', { name: row.original.createdBy?.name || row.original.createdBy?.email || '—' })}
                            </span>
                        </span>
                    ),
                },
                {
                    id: 'actions',
                    header: () => <span className="sr-only">{t('actions')}</span>,
                    cell: ({ row }) => (
                        <div className="text-right">
                            <Tooltip content={t('revokeKey')}>
                                <Button
                                    variant="destructive-outline"
                                    size="xs"
                                    onClick={() => handleRevoke(row.original)}
                                    aria-label={t('revokeKey')}
                                    id={`revoke-key-${row.original.id}`}
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                </Button>
                            </Tooltip>
                        </div>
                    ),
                },
            ]),
        // handleRevoke identity is stable within this component — but we
        // include it so an eslint-exhaustive-deps warning doesn't slip in
        // if someone refactors it into a useCallback later.

        [],
    );

    const inactiveKeyColumns = useMemo(
        () =>
            createColumns<ApiKeyRecord>([
                {
                    accessorKey: 'name',
                    header: t('colName'),
                    cell: ({ row }) => (
                        <span className="text-sm text-content-muted line-through">{row.original.name}</span>
                    ),
                },
                {
                    accessorKey: 'keyPrefix',
                    header: t('colKey'),
                    cell: ({ row }) => (
                        <code className="text-content-subtle font-mono">{row.original.keyPrefix}...</code>
                    ),
                },
                {
                    id: 'status',
                    header: t('colStatus'),
                    cell: ({ row }) =>
                        row.original.revokedAt ? (
                            <StatusBadge variant="error" size="sm">{t('revoked')}</StatusBadge>
                        ) : (
                            <StatusBadge variant="warning" size="sm">{t('expired')}</StatusBadge>
                        ),
                },
                {
                    accessorKey: 'createdAt',
                    header: t('colCreated'),
                    cell: ({ row }) => (
                        <span className="text-content-subtle">{formatDateTime(row.original.createdAt)}</span>
                    ),
                },
            ]),
        [],
    );

    if (loading) {
        return (
            <div className="space-y-section animate-fadeIn">
                <Heading level={2} className="flex items-center gap-tight">
                    <KeyRound className="w-6 h-6 text-[var(--brand-default)]" />
                    {t('loading')}
                </Heading>
                <Card className="space-y-default">
                    <div className="h-4 bg-bg-elevated/60 rounded w-1/3 animate-pulse" />
                    <div className="h-4 bg-bg-elevated/60 rounded w-2/3 animate-pulse" />
                </Card>
            </div>
        );
    }

    return (
        <div className="space-y-section animate-fadeIn">
            {/* Header */}
            <div className="flex items-center justify-between flex-wrap gap-default">
                <div>
                    <PageBreadcrumbs
                        items={[
                            { label: t('breadcrumbDashboard'), href: tenantHref('/dashboard') },
                            { label: t('breadcrumbAdmin'), href: tenantHref('/admin') },
                            { label: t('breadcrumbApiKeys') },
                        ]}
                        className="mb-1"
                    />
                    <Heading level={1} className="flex items-center gap-tight">
                        <KeyRound className="w-6 h-6 text-[var(--brand-default)]" />
                        {t('heading')}
                    </Heading>
                    <p className="text-sm text-content-muted mt-1">
                        {t('description')}
                    </p>
                </div>
                {!showCreate && !createdKey && (
                    <Button variant="primary" icon={<Plus />} onClick={() => setShowCreate(true)} id="create-api-key-btn">
                        {t('newApiKeyButton')}
                    </Button>
                )}
            </div>

            {/* Messages */}
            {error && (
                <InlineNotice
                    variant="error"
                    id="api-keys-error"
                    onDismiss={() => setError(null)}
                >
                    {error}
                </InlineNotice>
            )}
            {success && (
                <InlineNotice
                    variant="success"
                    id="api-keys-success"
                    onDismiss={() => setSuccess(null)}
                >
                    {success}
                </InlineNotice>
            )}

            {/* Created Key Display (show once) */}
            {createdKey && (
                <div className="space-y-tight">
                    <KeyDisplay plaintext={createdKey.plaintext} />
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setCreatedKey(null)}
                        id="dismiss-key-display"
                    >
                        {t('copiedDismiss')}
                    </Button>
                </div>
            )}

            {/* Create Form */}
            {showCreate && (
                <div className={cn(cardVariants(), 'border border-[var(--brand-default)]/30 space-y-default')} id="create-key-form">
                    <Heading level={3}>{t('createApiKey')}</Heading>

                    <div>
                        <label className="text-xs text-content-muted uppercase tracking-wider mb-1 block">{t('nameLabel')}</label>
                        <input
                            type="text" value={createName} onChange={(e) => setCreateName(e.target.value)}
                            placeholder={t('namePlaceholder')}
                            className="input w-full" maxLength={100} id="key-name-input"
                        />
                    </div>

                    <div>
                        <div className="mb-1 flex items-center gap-1.5">
                            <label className="text-xs text-content-muted uppercase tracking-wider">{t('expiryLabel')}</label>
                            <InfoTooltip
                                aria-label={t('expiryAbout')}
                                iconClassName="h-3.5 w-3.5"
                                content={t('expiryTooltip')}
                            />
                        </div>
                        <Combobox
                            hideSearch
                            id="key-expiry-select"
                            selected={EXPIRY_CB_OPTIONS.find(o => o.value === createExpiry) ?? null}
                            setSelected={(opt) => setCreateExpiry(opt?.value ?? '')}
                            options={EXPIRY_CB_OPTIONS}
                            placeholder={t('noExpiry')}
                            matchTriggerWidth
                            buttonProps={{ className: 'w-full sm:w-48' }}
                        />
                    </div>

                    <div>
                        <label className="text-xs text-content-muted uppercase tracking-wider mb-2 block">{t('scopesLabel')}</label>
                        <ScopePicker selected={createScopes} onChange={setCreateScopes} />
                    </div>

                    <div className="flex gap-tight pt-2">
                        <Button
                            variant="primary"
                            onClick={handleCreate}
                            disabled={creating || !createName.trim() || createScopes.length === 0}
                            loading={creating}
                            id="key-submit-btn"
                        >
                            {creating ? t('creating') : t('createKey')}
                        </Button>
                        <Button variant="secondary" onClick={() => setShowCreate(false)}>{t('cancel')}</Button>
                    </div>
                </div>
            )}

            {/* Active Keys. R13-PR5 — the outer
                `cardVariants({ density: 'none' })` wrapper was dropped
                so the DataTable primitive's own bordered card is the
                only one (matches Controls list visually). The section
                heading hoists out above the table. */}
            <div id="active-keys-card">
                <Heading level={3} className="mb-3">{t('activeKeys', { count: activeKeys.length })}</Heading>
                <DataTable
                    data={activeKeys}
                    columns={activeKeyColumns}
                    getRowId={(k) => k.id}
                    batchActions={[bulkRevokeAction]}
                    emptyState={t('noActiveKeys')}
                    resourceName={(p) => (p ? t('apiKeyPlural') : t('apiKeySingular'))}
                    data-testid="active-keys-table"
                />
            </div>

            {/* Inactive/Revoked Keys */}
            {inactiveKeys.length > 0 && (
                <div className="opacity-60" id="inactive-keys-card">
                    <Heading level={3} className="mb-3">{t('revokedExpired', { count: inactiveKeys.length })}</Heading>
                    <DataTable
                        data={inactiveKeys}
                        columns={inactiveKeyColumns}
                        getRowId={(k) => k.id}
                        emptyState={t('noRevokedExpired')}
                        resourceName={(p) => (p ? t('revokedKeyPlural') : t('revokedKeySingular'))}
                        data-testid="inactive-keys-table"
                    />
                </div>
            )}

            <ConfirmDialog
                showModal={keyToRevoke !== null}
                setShowModal={(open) => {
                    if (typeof open === 'function') {
                        const next = open(keyToRevoke !== null);
                        if (!next) setKeyToRevoke(null);
                    } else if (!open) {
                        setKeyToRevoke(null);
                    }
                }}
                tone="danger"
                title={
                    keyToRevoke
                        ? t('confirmRevokeTitle', { name: keyToRevoke.name })
                        : t('confirmRevokeTitleGeneric')
                }
                description={
                    keyToRevoke
                        ? t('confirmRevokeDesc', { prefix: keyToRevoke.keyPrefix })
                        : undefined
                }
                confirmLabel={t('revokeKey')}
                onConfirm={async () => {
                    if (keyToRevoke) await performRevoke(keyToRevoke);
                }}
            />

            {bulkRevokeDialog}
        </div>
    );
}
