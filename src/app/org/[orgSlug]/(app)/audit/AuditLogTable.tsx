'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ScrollText } from 'lucide-react';

import { ListPageShell } from '@/components/layout/ListPageShell';
import { DataTable, createColumns, TableEmptyState } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { useDateFormat } from '@/lib/i18n/use-date-format';
import { Heading } from '@/components/ui/typography';

interface UserRef {
    id: string;
    email: string | null;
    name: string | null;
}

interface AuditRow {
    id: string;
    occurredAt: string;
    action:
        | 'ORG_MEMBER_ADDED'
        | 'ORG_MEMBER_REMOVED'
        | 'ORG_MEMBER_ROLE_CHANGED'
        | 'ORG_ADMIN_PROVISIONED_TO_TENANTS'
        | 'ORG_ADMIN_DEPROVISIONED_FROM_TENANTS';
    actorType: string;
    actor: UserRef | null;
    target: UserRef | null;
    detailsJson: unknown;
    requestId: string | null;
    entryHash: string;
    previousHash: string | null;
    version: number;
}

interface Props {
    orgSlug: string;
    initialRows: AuditRow[];
    initialNextCursor: string | null;
}

const ACTION_LABEL_KEY: Record<AuditRow['action'], string> = {
    ORG_MEMBER_ADDED: 'actionMemberAdded',
    ORG_MEMBER_REMOVED: 'actionMemberRemoved',
    ORG_MEMBER_ROLE_CHANGED: 'actionRoleChanged',
    ORG_ADMIN_PROVISIONED_TO_TENANTS: 'actionProvisioned',
    ORG_ADMIN_DEPROVISIONED_FROM_TENANTS: 'actionDeprovisioned',
};

const ACTION_VARIANT: Record<AuditRow['action'], 'success' | 'error' | 'info' | 'warning'> = {
    ORG_MEMBER_ADDED: 'success',
    ORG_MEMBER_REMOVED: 'error',
    ORG_MEMBER_ROLE_CHANGED: 'warning',
    ORG_ADMIN_PROVISIONED_TO_TENANTS: 'info',
    ORG_ADMIN_DEPROVISIONED_FROM_TENANTS: 'info',
};

/**
 * Defensive renderer — strips PII ciphertext envelopes that may leak
 * through if the read-side decryption fails. Same pattern as
 * `user-combobox.tsx::isCiphertextEnvelope` (PR #82).
 */
function readableField(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('v1:') || trimmed.startsWith('v2:')) return null;
    return trimmed;
}

function userLabel(u: UserRef | null): string {
    if (!u) return '—';
    const name = readableField(u.name);
    const email = readableField(u.email);
    if (name && email) return `${name} (${email})`;
    if (name) return name;
    if (email) return email;
    return `User ${u.id.slice(0, 8)}`;
}

/**
 * Compact, human-readable summary of the row's `detailsJson`. Each
 * action shape carries different fields — the details payload is
 * authoritative; this is just a glance-friendly projection.
 */
function summarize(
    row: AuditRow,
    t: ReturnType<typeof useTranslations>,
): string {
    const d = row.detailsJson as Record<string, unknown> | null;
    if (!d) return '';
    switch (row.action) {
        case 'ORG_MEMBER_ADDED':
            return (
                t('summaryRole', { role: String(d.role ?? '—') }) +
                (typeof d.provisionedTenantCount === 'number' && d.provisionedTenantCount > 0
                    ? ` · ${t('summaryProvisioned', { count: d.provisionedTenantCount })}`
                    : '')
            );
        case 'ORG_MEMBER_REMOVED':
            return (
                t('summaryWas', { role: String(d.previousRole ?? '—') }) +
                (typeof d.deprovisionedTenantCount === 'number' && d.deprovisionedTenantCount > 0
                    ? ` · ${t('summaryDeprovisioned', { count: d.deprovisionedTenantCount })}`
                    : '')
            );
        case 'ORG_MEMBER_ROLE_CHANGED':
            return `${d.previousRole ?? '—'} → ${d.newRole ?? '—'}`;
        case 'ORG_ADMIN_PROVISIONED_TO_TENANTS':
        case 'ORG_ADMIN_DEPROVISIONED_FROM_TENANTS':
            return typeof d.tenantCount === 'number'
                ? t('summaryFanout', {
                      count: d.tenantCount,
                      role: String(d.role ?? 'AUDITOR'),
                  })
                : '';
        default:
            return '';
    }
}

export function AuditLogTable({ orgSlug, initialRows, initialNextCursor }: Props) {
    const { formatDateTime } = useDateFormat();
    const t = useTranslations('org.audit');
    const [rows, setRows] = useState<AuditRow[]>(initialRows);
    const [cursor, setCursor] = useState<string | null>(initialNextCursor);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const loadMore = useCallback(async () => {
        if (!cursor || loading) return;
        setLoading(true);
        setError(null);
        try {
            const url = `/api/org/${orgSlug}/audit-log?cursor=${encodeURIComponent(cursor)}&limit=20`;
            const res = await fetch(url);
            if (!res.ok) {
                throw new Error(`Audit log fetch failed: ${res.status}`);
            }
            const data = (await res.json()) as { rows: AuditRow[]; nextCursor: string | null };
            setRows((prev) => [...prev, ...data.rows]);
            setCursor(data.nextCursor);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Audit log fetch failed');
        } finally {
            setLoading(false);
        }
    }, [orgSlug, cursor, loading]);

    const columns = useMemo(
        () =>
            createColumns<AuditRow>([
                {
                    id: 'occurredAt',
                    header: t('colTime'),
                    cell: ({ row }) => (
                        <span
                            className="font-mono text-xs text-content-muted"
                            data-testid={`org-audit-time-${row.original.id}`}
                        >
                            {formatDateTime(row.original.occurredAt)}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colTime') } },
                },
                {
                    id: 'action',
                    header: t('colAction'),
                    cell: ({ row }) => (
                        <StatusBadge variant={ACTION_VARIANT[row.original.action]}>
                            {t(ACTION_LABEL_KEY[row.original.action])}
                        </StatusBadge>
                    ),
                    meta: { mobileCard: { slot: 'status', label: t('colAction') } },
                },
                {
                    id: 'actor',
                    header: t('colActor'),
                    cell: ({ row }) => (
                        <span className="text-sm text-content-default">
                            {userLabel(row.original.actor)}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'title' } },
                },
                {
                    id: 'target',
                    header: t('colTarget'),
                    cell: ({ row }) => (
                        <span className="text-sm text-content-default">
                            {userLabel(row.original.target)}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colTarget') } },
                },
                {
                    id: 'summary',
                    header: t('colSummary'),
                    cell: ({ row }) => (
                        <span className="text-sm text-content-muted">
                            {summarize(row.original, t)}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'subtitle' } },
                },
            ]),
        [t, formatDateTime],
    );

    return (
        <ListPageShell>
            <ListPageShell.Header>
                <div className="flex items-start justify-between gap-default">
                    <div>
                        <Heading level={1} className="flex items-center gap-tight">
                            <ScrollText className="w-5 h-5" aria-hidden="true" />
                            {t('title')}
                        </Heading>
                        <p className="text-sm text-content-muted mt-1">
                            {t('description')}
                        </p>
                    </div>
                </div>
            </ListPageShell.Header>
            <ListPageShell.Body>
                {rows.length === 0 ? (
                    <TableEmptyState
                        title={t('emptyTitle')}
                        description={t('emptyDesc')}
                    />
                ) : (
                    <DataTable
                        fillBody
                        mobileFallback="card"
                        data={rows}
                        columns={columns}
                        getRowId={(r) => r.id}
                    />
                )}
                {error && (
                    <p
                        role="alert"
                        className="mt-3 text-sm text-status-error"
                        data-testid="org-audit-error"
                    >
                        {error}
                    </p>
                )}
                {cursor && (
                    <div className="mt-4 flex justify-center">
                        <Button
                            variant="secondary"
                            onClick={loadMore}
                            disabled={loading}
                            data-testid="org-audit-load-more"
                        >
                            {loading ? t('loading') : t('loadMore')}
                        </Button>
                    </div>
                )}
            </ListPageShell.Body>
        </ListPageShell>
    );
}
