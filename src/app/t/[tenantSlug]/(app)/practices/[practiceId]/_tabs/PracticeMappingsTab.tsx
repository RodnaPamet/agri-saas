'use client';

/**
 * Practice detail — Mappings tab (#102 item 1, tab-lazy refactor).
 *
 * Extracted from the 1,500-line practice detail page. Fully
 * self-contained: it owns the framework-mapping list
 * (`useTenantSWR` — fetched only because this component mounts only
 * when the Mappings tab is active), plus the framework / requirement
 * pickers for the "map a requirement" form and the map / unmap
 * mutations.
 *
 * `onMutated` lets the parent revalidate its page-data header so the
 * Mappings tab-badge count stays in sync after a map / unmap.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useToastWithUndo } from '@/components/ui/hooks';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons/nucleo/plus';
import { Combobox } from '@/components/ui/combobox';
import { InlineEmptyState } from '@/components/ui/inline-empty-state';
import { CopyText } from '@/components/ui/copy-text';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { DataTable, createColumns } from '@/components/ui/table';
import type { FrameworkDTO, RequirementDTO, FrameworkMappingDTO } from '@/lib/dto';

interface PracticeMappingsTabProps {
    practiceId: string;
    canWrite: boolean;
    /** Revalidate the page-data header — keeps the tab-badge current. */
    onMutated: () => void;
}

export function PracticeMappingsTab({
    practiceId,
    canWrite,
    onMutated,
}: PracticeMappingsTabProps) {
    const t = useTranslations('practices');
    const apiUrl = useTenantApiUrl();
    const triggerUndoToast = useToastWithUndo();

    const mappingsSWR = useTenantSWR<FrameworkMappingDTO[]>(
        CACHE_KEYS.practices.mappings(practiceId),
    );

    const [showMapForm, setShowMapForm] = useState(false);
    const [frameworks, setFrameworks] = useState<FrameworkDTO[]>([]);
    const [selectedFramework, setSelectedFramework] = useState('');
    const [requirements, setRequirements] = useState<RequirementDTO[]>([]);
    const [selectedReq, setSelectedReq] = useState('');
    const [savingMap, setSavingMap] = useState(false);

    // Frameworks load once — the component mounts only when the
    // Mappings tab is active, so there's no tab gate to check.
    useEffect(() => {
        fetch(apiUrl('/practices/frameworks'))
            .then((r) => (r.ok ? r.json() : []))
            .then(setFrameworks)
            .catch(() => {});
    }, [apiUrl]);

    // Requirements reload whenever the selected framework changes.
    useEffect(() => {
        if (!selectedFramework) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setRequirements([]);
            return;
        }
        fetch(apiUrl(`/practices/frameworks/${selectedFramework}/requirements`))
            .then((r) => (r.ok ? r.json() : []))
            .then(setRequirements)
            .catch(() => {});
    }, [selectedFramework, apiUrl]);

    const mapRequirement = async () => {
        if (!selectedReq) return;
        setSavingMap(true);
        await fetch(apiUrl(`/practices/${practiceId}/requirements`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requirementId: selectedReq }),
        });
        setSelectedReq('');
        setShowMapForm(false);
        await mappingsSWR.mutate();
        onMutated();
        setSavingMap(false);
    };

    // Epic 67 — delayed-commit unmap against this tab's own SWR
    // cache. Optimistically drop the row; the DELETE fires after the
    // 5 s undo window.
    const unmapRequirement = (reqId: string) => {
        const previous = mappingsSWR.data;
        if (previous) {
            mappingsSWR.mutate(
                previous.filter(
                    (m) =>
                        m.fromRequirement?.id !== reqId &&
                        m.fromRequirementId !== reqId,
                ),
                { revalidate: false },
            );
        }
        triggerUndoToast({
            message: t('mappings.unmappedToast'),
            undoMessage: t('mappings.undo'),
            action: async () => {
                const res = await fetch(
                    apiUrl(`/practices/${practiceId}/requirements`),
                    {
                        method: 'DELETE',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ requirementId: reqId }),
                    },
                );
                if (!res.ok) throw new Error('Unmap failed');
                await mappingsSWR.mutate();
                onMutated();
            },
            undoAction: () => {
                if (previous) {
                    mappingsSWR.mutate(previous, { revalidate: false });
                }
            },
            onError: () => {
                if (previous) {
                    mappingsSWR.mutate(previous, { revalidate: false });
                }
            },
        });
    };

    // R10-PR3 follow-up: framework-mapping rows now flow through
    // DataTable. The 2-column shape (Framework + Requirement) plus
    // optional Actions column matches the R11-PR8 task-links template;
    // CopyText-on-code, error tone, and the canWrite gate are all
    // preserved inside cell renderers.
    const columns = useMemo(
        () =>
            createColumns<FrameworkMappingDTO>([
                {
                    id: 'framework',
                    header: t('mappings.colFramework'),
                    cell: ({ row }) => (
                        <span className="text-sm text-content-emphasis">
                            {row.original.fromRequirement?.framework?.name || '—'}
                        </span>
                    ),
                },
                {
                    id: 'requirement',
                    header: t('mappings.colRequirement'),
                    cell: ({ row }) => {
                        const fromReq = row.original.fromRequirement;
                        return (
                            <span className="text-sm text-content-default">
                                {fromReq?.code && (
                                    <CopyText
                                        value={fromReq.code}
                                        label={t('mappings.copyCode', { code: fromReq.code })}
                                        successMessage={t('mappings.codeCopied')}
                                        className="mr-2 text-content-subtle"
                                    >
                                        {fromReq.code}
                                    </CopyText>
                                )}
                                {fromReq?.title || fromReq?.description || '—'}
                            </span>
                        );
                    },
                },
                ...(canWrite
                    ? [
                          {
                              id: 'actions',
                              header: t('mappings.colActions'),
                              cell: ({ row }: { row: { original: FrameworkMappingDTO } }) => (
                                  <button
                                      className="text-content-error text-xs hover:text-content-error"
                                      onClick={() =>
                                          unmapRequirement(
                                              row.original.fromRequirement?.id ||
                                                  row.original.fromRequirementId ||
                                                  '',
                                          )
                                      }
                                      id={`unmap-${row.original.id}`}
                                  >
                                      × {t('mappings.remove')}
                                  </button>
                              ),
                          },
                      ]
                    : []),
            ]),
        // unmapRequirement closes over SWR state, so include the data
        // fingerprint as a dependency to avoid stale undo snapshots.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [canWrite, mappingsSWR.data, t],
    );

    return (
        <div className="space-y-default">
            {canWrite && (
                <div className="flex justify-end">
                    <Button variant="primary" icon={<Plus className="-ml-0.5 -mr-2.5" />} onClick={() => setShowMapForm(!showMapForm)} id="map-requirement-btn">
                        {t('mappings.mapRequirement')}
                    </Button>
                </div>
            )}
            {showMapForm && canWrite && (
                <div className={cn(cardVariants({ density: 'compact' }), 'space-y-compact')}>
                    <Combobox
                        id="framework-select"
                        selected={frameworks.map((f) => ({ value: f.key ?? f.id ?? '', label: f.name })).find((o) => o.value === selectedFramework) ?? null}
                        setSelected={(opt) => setSelectedFramework(opt?.value ?? '')}
                        options={frameworks.map((f) => ({ value: f.key ?? f.id ?? '', label: f.name }))}
                        placeholder={t('mappings.phFramework')}
                        matchTriggerWidth
                    />
                    {requirements.length > 0 && (
                        <>
                            <Combobox
                                id="requirement-select"
                                selected={requirements.map((r) => ({ value: r.id, label: `${r.code ? `${r.code} — ` : ''}${r.title || r.description}` })).find((o) => o.value === selectedReq) ?? null}
                                setSelected={(opt) => setSelectedReq(opt?.value ?? '')}
                                options={requirements.map((r) => ({ value: r.id, label: `${r.code ? `${r.code} — ` : ''}${r.title || r.description}` }))}
                                placeholder={t('mappings.phRequirement')}
                                matchTriggerWidth
                            />
                            <Button variant="primary" onClick={mapRequirement} disabled={!selectedReq || savingMap} id="submit-mapping-btn">
                                {savingMap ? t('mappings.mapping') : t('mappings.map')}
                            </Button>
                        </>
                    )}
                </div>
            )}
            {mappingsSWR.error && !mappingsSWR.isLoading ? (
                <InlineEmptyState
                    title={t('mappings.loadErrorTitle')}
                    description={t('mappings.loadErrorDesc')}
                />
            ) : (mappingsSWR.data?.length ?? 0) === 0 ? (
                // Pre-migration the empty branch rendered an
                // InlineEmptyState — no `#mappings-table` was in the
                // DOM. E2E specs that look up `#mappings-table` are
                // therefore waiting for data to arrive; preserve
                // that contract by gating the id on rows-present.
                // `selectionEnabled={false}` keeps the unmap-button
                // selector working (see EvidenceSubTable comment).
                <DataTable
                    data={[]}
                    columns={columns}
                    getRowId={(m) => m.id}
                    loading={mappingsSWR.isLoading && !mappingsSWR.data}
                    selectionEnabled={false}
                    emptyState={
                        <InlineEmptyState
                            title={t('mappings.emptyTitle')}
                            description={t('mappings.emptyDesc')}
                        />
                    }
                />
            ) : (
                <div id="mappings-table">
                    <DataTable
                        data={mappingsSWR.data ?? []}
                        columns={columns}
                        getRowId={(m) => m.id}
                        selectionEnabled={false}
                    />
                </div>
            )}
        </div>
    );
}
