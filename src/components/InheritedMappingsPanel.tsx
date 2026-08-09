'use client';

/**
 * Read-only framework-mappings list for Asset / Risk detail pages.
 * Framework requirements map to practices, so an asset/risk inherits
 * its framework coverage from the practices it is mapped to. This
 * panel fetches the aggregated requirement links (each tagged with
 * its owning practice) and renders them — no add/unlink, since the
 * mapping lives on the practice.
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { DataTable, createColumns } from '@/components/ui/table';
import { TableTitleCell } from '@/components/ui/table-title-cell';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';

interface PracticeRef {
    id: string;
    code: string | null;
    name: string;
}
interface FrameworkRef {
    id: string;
    name: string;
    version: string | null;
}
interface InheritedMappingRow {
    requirementId: string;
    code: string;
    title: string;
    framework: FrameworkRef | null;
    practice: PracticeRef | null;
}

export function InheritedMappingsPanel({
    endpoint,
    tenantHref,
    entityLabel,
}: {
    /** Fully-qualified tenant API path, e.g. apiUrl('/assets/123/mappings'). */
    endpoint: string;
    tenantHref: (path: string) => string;
    /** 'asset' | 'risk' — used only in the explanatory copy. */
    entityLabel: string;
}) {
    const t = useTranslations('inherited.mappings');
    const [rows, setRows] = useState<InheritedMappingRow[]>([]);
    const [loading, setLoading] = useState(true);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        (async () => {
            try {
                const res = await fetch(endpoint);
                const data = res.ok ? await res.json() : [];
                if (!cancelled) setRows(Array.isArray(data) ? data : []);
            } catch {
                if (!cancelled) setRows([]);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [endpoint]);

    const columns = createColumns<InheritedMappingRow>([
        {
            id: 'code',
            header: t('colRequirement'),
            accessorFn: (r) => r.code,
            cell: ({ row }) => (
                <span className="text-sm font-medium text-content-default">
                    {row.original.code}
                </span>
            ),
        },
        {
            accessorKey: 'title',
            header: t('colTitle'),
            cell: ({ getValue }) => (
                <span className="text-sm text-content-default">{getValue<string>()}</span>
            ),
        },
        {
            id: 'framework',
            header: t('colFramework'),
            cell: ({ row }) =>
                row.original.framework ? (
                    <StatusBadge variant="info" size="sm">
                        {row.original.framework.name}
                        {row.original.framework.version
                            ? ` ${row.original.framework.version}`
                            : ''}
                    </StatusBadge>
                ) : (
                    <span className="text-xs text-content-subtle">—</span>
                ),
        },
        {
            id: 'practice',
            header: t('colViaPractice'),
            cell: ({ row }) =>
                row.original.practice ? (
                    <TableTitleCell href={tenantHref(`/practices/${row.original.practice.id}`)}>
                        {row.original.practice.code ||
                            row.original.practice.name}
                    </TableTitleCell>
                ) : (
                    <span className="text-xs text-content-subtle">—</span>
                ),
        },
    ]);

    return (
        <div className="space-y-default">
            <InlineNotice variant="info">
                {t('notice', { entityLabel })}
            </InlineNotice>
            <DataTable<InheritedMappingRow>
                data={rows}
                columns={columns}
                loading={loading}
                getRowId={(r) => `${r.requirementId}:${r.practice?.id ?? 'none'}`}
                emptyState={
                    <EmptyState
                        size="sm"
                        variant="no-records"
                        title={t('emptyTitle')}
                        description={t('emptyDesc', { entityLabel })}
                    />
                }
            />
        </div>
    );
}
