'use client';

import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiPost, apiPatch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Plus, CalendarIcon, PenWriting } from '@/components/ui/icons/nucleo';
import { Tooltip } from '@/components/ui/tooltip';
import { useToast } from '@/components/ui/hooks';
import { createColumns } from '@/components/ui/table';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { EmptyState } from '@/components/ui/empty-state';
import { AgStatusBadge } from '@/components/ag/ag-status';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker';
import { useDateFormat } from '@/lib/i18n/use-date-format';

interface SeasonRow {
    id: string;
    name: string;
    status: string;
    startDate: string;
    endDate: string;
    _count?: { cropPlans?: number };
}

interface SeasonsClientProps {
    initialSeasons: SeasonRow[];
    tenantSlug: string;
    permissions: { canWrite: boolean };
}

export function SeasonsClient({ initialSeasons, tenantSlug, permissions }: SeasonsClientProps) {
    const { formatDate } = useDateFormat();
    const t = useTranslations('planning.seasons');
    const tp = useTranslations('planning');
    const tenantHref = (path: string) => `/t/${tenantSlug}${path}`;
    const buildUrl = useTenantApiUrl();
    const toast = useToast();
    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const [editSeason, setEditSeason] = useState<SeasonRow | null>(null);

    // Season-wide БАБХ ДНЕВНИК — one combined diary across every location with
    // completed ops in the season (one section-set per location, page-break
    // between). Backend: POST /reports/season-diary?seasonId=… streams the PDF.
    const downloadSeasonDiary = useCallback(
        async (season: SeasonRow) => {
            try {
                const res = await fetch(buildUrl(`/reports/season-diary?seasonId=${season.id}`), {
                    method: 'POST',
                });
                if (!res.ok) throw new Error('season diary failed');
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `dnevnik-season-${season.name.replace(/\s+/g, '_')}.pdf`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            } catch {
                toast.error(t('diaryFailed'));
            }
        },
        [buildUrl, toast, t],
    );

    const seasonsSWR = useTenantSWR<SeasonRow[]>('/planning/seasons', {
        fallbackData: initialSeasons,
    });
    const seasons = seasonsSWR.data ?? [];
    const loading = seasonsSWR.isLoading && !seasonsSWR.data;

    const columns = useMemo(
        () =>
            createColumns<SeasonRow>([
                {
                    accessorKey: 'name',
                    header: t('colSeason'),
                    cell: ({ getValue }) => (
                        <span className="text-sm text-content-emphasis">{getValue() as string}</span>
                    ),
                    meta: { mobileCard: { slot: 'title' } },
                },
                {
                    id: 'window',
                    header: t('colWindow'),
                    accessorFn: (s) => s.startDate,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted">
                            {formatDate(row.original.startDate)} – {formatDate(row.original.endDate)}
                        </span>
                    ),
                    meta: { disableTruncate: true, mobileCard: { slot: 'meta', label: t('colWindow') } },
                },
                {
                    id: 'plans',
                    header: t('colPlans'),
                    accessorFn: (s) => s._count?.cropPlans ?? 0,
                    cell: ({ getValue }) => (
                        <span className="text-xs text-content-muted tabular-nums">{getValue() as number}</span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colPlans') } },
                },
                {
                    accessorKey: 'status',
                    header: t('colStatus'),
                    cell: ({ row }) => (
                        <AgStatusBadge entity="season" status={row.original.status} />
                    ),
                    meta: { mobileCard: { slot: 'status', label: t('colStatus') } },
                },
                {
                    id: 'actions',
                    header: '',
                    enableHiding: false,
                    cell: ({ row }) => (
                        <div className="flex items-center justify-end gap-tight">
                            {permissions.canWrite && (
                                <Tooltip content={t('editTooltip')}>
                                    <button
                                        type="button"
                                        aria-label={t('editAria')}
                                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-content-muted hover:bg-bg-muted hover:text-content-emphasis"
                                        id={`season-edit-${row.original.id}`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setEditSeason(row.original);
                                        }}
                                    >
                                        <PenWriting className="h-3.5 w-3.5" aria-hidden />
                                    </button>
                                </Tooltip>
                            )}
                            <Tooltip content={t('diaryTooltip')}>
                                <button
                                    type="button"
                                    aria-label={t('diaryAria')}
                                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-content-muted hover:bg-bg-muted hover:text-content-emphasis"
                                    data-testid={`season-diary-${row.original.id}`}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        void downloadSeasonDiary(row.original);
                                    }}
                                >
                                    <CalendarIcon className="h-3.5 w-3.5" aria-hidden />
                                </button>
                            </Tooltip>
                        </div>
                    ),
                },
            ]),
        [downloadSeasonDiary, t, permissions.canWrite, formatDate],
    );

    return (
        <EntityListPage<SeasonRow>
            className="animate-fadeIn gap-section"
            header={{
                breadcrumbs: [
                    { label: tp('bcDashboard'), href: tenantHref('/dashboard') },
                    { label: tp('bcPlanting'), href: tenantHref('/planning') },
                    { label: tp('bcSeasons') },
                ],
                title: t('title'),
                description: t('description'),
                actions: permissions.canWrite ? (
                    <Button
                        variant="primary"
                        icon={<Plus className="-ml-0.5 -mr-2.5" />}
                        onClick={() => setIsCreateOpen(true)}
                        id="new-season-btn"
                    >
                        {t('newSeason')}
                    </Button>
                ) : null,
            }}
            table={{
                data: seasons,
                columns,
                loading,
                getRowId: (s) => s.id,
                mobileFallback: 'card',
                emptyState: (
                    <EmptyState
                        size="sm"
                        variant="no-records"
                        title={t('emptyTitle')}
                        description={t('emptyDesc')}
                        primaryAction={
                            permissions.canWrite
                                ? { label: t('addSeason'), onClick: () => setIsCreateOpen(true) }
                                : undefined
                        }
                    />
                ),
                resourceName: (p) => (p ? t('resourcePlural') : t('resourceSingular')),
                'data-testid': 'seasons-table',
                className: 'hover:bg-bg-muted',
            }}
        >
            {permissions.canWrite && (
                <>
                    <SeasonModal
                        open={isCreateOpen}
                        setOpen={setIsCreateOpen}
                        onSaved={() => void seasonsSWR.mutate()}
                    />
                    {editSeason && (
                        <SeasonModal
                            open
                            setOpen={(o) => {
                                const next = typeof o === 'function' ? o(true) : o;
                                if (!next) setEditSeason(null);
                            }}
                            season={editSeason}
                            onSaved={() => void seasonsSWR.mutate()}
                        />
                    )}
                </>
            )}
        </EntityListPage>
    );
}

function SeasonModal({
    open,
    setOpen,
    season,
    onSaved,
}: {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    /** When provided, the modal edits this season (PATCH) instead of creating. */
    season?: SeasonRow | null;
    onSaved?: () => void;
}) {
    const t = useTranslations('planning.seasons');
    const buildUrl = useTenantApiUrl();
    const isEdit = !!season;
    const STATUS_OPTIONS: ComboboxOption[] = useMemo(
        () => [
            { value: 'PLANNING', label: t('statusPlanning') },
            { value: 'ACTIVE', label: t('statusActive') },
            { value: 'CLOSED', label: t('statusClosed') },
        ],
        [t],
    );
    const [name, setName] = useState(season?.name ?? '');
    const [status, setStatus] = useState(season?.status ?? 'PLANNING');
    const [startDate, setStartDate] = useState<Date | null>(season ? new Date(season.startDate) : new Date());
    const [endDate, setEndDate] = useState<Date | null>(season ? new Date(season.endDate) : null);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const canSubmit = name.trim().length > 0 && startDate && endDate && !submitting;

    const submit = async () => {
        if (!canSubmit || !startDate || !endDate) return;
        setSubmitting(true);
        setError(null);
        try {
            const body = {
                name: name.trim(),
                status,
                startDate: startDate.toISOString(),
                endDate: endDate.toISOString(),
                year: startDate.getUTCFullYear(),
            };
            if (isEdit && season) {
                await apiPatch(buildUrl(`/planning/seasons/${season.id}`), body);
            } else {
                await apiPost(buildUrl('/planning/seasons'), body);
                setName('');
                setStatus('PLANNING');
                setStartDate(new Date());
                setEndDate(null);
            }
            setOpen(false);
            onSaved?.();
        } catch (err) {
            setError(err instanceof Error ? err.message : isEdit ? t('saveFailed') : t('createFailed'));
        } finally {
            setSubmitting(false);
        }
    };

    const heading = isEdit ? t('editHeading') : t('modalHeading');
    const description = isEdit ? t('editDescription') : t('modalDescription');

    return (
        <Modal
            showModal={open}
            setShowModal={setOpen}
            size="md"
            title={heading}
            description={description}
            preventDefaultClose={submitting}
        >
            <Modal.Header title={heading} description={description} />
            <Modal.Form
                id="season-form"
                onSubmit={(e) => {
                    e.preventDefault();
                    void submit();
                }}
            >
                <Modal.Body>
                    {error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="season-error"
                            role="alert"
                        >
                            {error}
                        </div>
                    )}
                    <fieldset disabled={submitting} className="m-0 p-0 border-0 space-y-default">
                        <FormField label={t('name')} required>
                            <Input
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder={t('namePlaceholder')}
                                id="season-name"
                            />
                        </FormField>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-default">
                            <FormField label={t('start')} required>
                                <DatePicker value={startDate} onChange={setStartDate} placeholder={t('startPlaceholder')} />
                            </FormField>
                            <FormField label={t('end')} required>
                                <DatePicker value={endDate} onChange={setEndDate} placeholder={t('endPlaceholder')} />
                            </FormField>
                            <FormField label={t('status')}>
                                <Combobox
                                    options={STATUS_OPTIONS}
                                    selected={STATUS_OPTIONS.find((o) => o.value === status) ?? null}
                                    setSelected={(o) => setStatus(o?.value ?? 'PLANNING')}
                                    aria-label={t('seasonStatus')}
                                    matchTriggerWidth
                                />
                            </FormField>
                        </div>
                    </fieldset>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        onClick={() => setOpen(false)}
                        disabled={submitting}
                        id="season-cancel"
                    >
                        {t('cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        disabled={!canSubmit}
                        loading={submitting}
                        id="season-submit"
                    >
                        {isEdit ? t('saveSeason') : t('createSeason')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
