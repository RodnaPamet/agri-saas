'use client';

import { useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useTenantApiUrl, useTenantHref, useTenantContext } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { MetaStrip } from '@/components/ui/meta-strip';
import { Button } from '@/components/ui/button';
import { Pen2, CalendarIcon, Trash } from '@/components/ui/icons/nucleo';
import { Tooltip } from '@/components/ui/tooltip';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { DatePicker, type DateValue } from '@/components/ui/date-picker';
import { toYMD } from '@/components/ui/date-picker/date-utils';
import { useToast, useToastWithUndo } from '@/components/ui/hooks';
import { Eyebrow, Heading } from '@/components/ui/typography';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { sanitizeRichTextHtml } from '@/lib/security/sanitize';
import { formatDateTime } from '@/lib/format-date';
import { JournalEntryModal } from '../JournalEntryModal';
import { JournalPhotosTab } from './JournalPhotosTab';
import { PestSuggestionCard, type PestSuggestionData } from '@/components/ag/pest-suggestion-card';
import { LOG_ENTRY_TYPE_LABELS } from '../filter-defs';
import { useTranslations } from 'next-intl';

const STATUS_BADGE: Record<string, StatusBadgeVariant> = {
    PLANNED: 'info',
    DONE: 'success',
};

type Tab = 'details' | 'quantities' | 'photos';

interface QuantityRow {
    id: string;
    measure: string;
    value: string | number;
    unitId: string;
    label?: string | null;
    unit?: { id: string; symbol: string; name: string } | null;
}
interface LocationLink {
    locationId?: string;
    location?: { id: string; name: string } | null;
}
interface EquipmentLink {
    // `LogEquipment` points at `Asset` since the Equipment merge. The
    // legacy field names stay accepted so an entry rendered from a
    // cached/offline payload minted before the merge still resolves.
    assetId?: string;
    asset?: { id: string; name: string; type?: string | null } | null;
    equipmentId?: string;
    equipment?: { id: string; name: string; category?: string | null } | null;
}
interface PhotoLink {
    id: string;
    caption?: string | null;
    createdAt: string;
    fileRecord?: { id: string; originalName?: string } | null;
}
interface LogEntryDetail {
    id: string;
    type: string;
    status: string;
    title: string;
    notes?: string | null;
    occurredAt: string;
    createdAt: string;
    updatedAt: string;
    quantities?: QuantityRow[];
    files?: PhotoLink[];
    locations?: LocationLink[];
    equipment?: EquipmentLink[];
    costAmount?: number | string | null;
    costCurrency?: string | null;
    attributesJson?: { pestId?: PestSuggestionData } | null;
    /** БАБХ — set when this entry is the INPUT_APPLICATION record of a field
     * operation, so the journal offers manual ДНЕВНИК generation. */
    operationParcelId?: string | null;
    fieldOperation?: { taskId: string; locationId: string } | null;
}

export default function JournalDetailPage() {
    const params = useParams();
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const { permissions, tenantSlug } = useTenantContext();
    const t = useTranslations('journal.detail');
    const te = useTranslations('journalEnums');
    const entryId = params.id as string;

    const detailKey = CACHE_KEYS.journal.detail(entryId);
    const { data: entry, error, isLoading, mutate } = useTenantSWR<LogEntryDetail>(detailKey);

    const [activeTab, setActiveTab] = useState<Tab>('details');
    const [editing, setEditing] = useState(false);
    const toast = useToast();
    const triggerUndoToast = useToastWithUndo();
    const router = useRouter();

    /**
     * Delete the entry — Epic 67 undo pattern. Entries are freely deletable by
     * design (the ДНЕВНИК sources from OperationParcel, not LogEntry), and a
     * soft delete is restorable from the journal Trash, so this is the routine
     * reversible branch: navigate back to the list and let the DELETE fire
     * after the 5s window.
     */
    const handleDeleteEntry = () => {
        triggerUndoToast({
            message: t('entryDeleted'),
            undoMessage: t('undo'),
            action: async () => {
                const res = await fetch(apiUrl(`/journal/${entryId}`), { method: 'DELETE' });
                if (!res.ok) throw new Error('Delete failed');
            },
        });
        router.push(tenantHref('/journal'));
    };

    // БАБХ ДНЕВНИК (PDF) — offered on entries that record a field operation.
    const [showDnevnik, setShowDnevnik] = useState(false);
    const [dnevnikBusy, setDnevnikBusy] = useState(false);
    const [dnevnikFrom, setDnevnikFrom] = useState<DateValue>(() => {
        const n = new Date();
        return new Date(Date.UTC(n.getFullYear(), 0, 1));
    });
    const [dnevnikTo, setDnevnikTo] = useState<DateValue>(() => {
        const n = new Date();
        return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
    });
    const generateDnevnik = async () => {
        const locationId = entry?.fieldOperation?.locationId;
        if (!locationId) return;
        setDnevnikBusy(true);
        try {
            const res = await fetch(apiUrl(`/locations/${locationId}/farm-record`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: toYMD(dnevnikFrom), to: toYMD(dnevnikTo) }),
            });
            if (!res.ok) throw new Error('generation failed');
            const blob = await res.blob();
            const disposition = res.headers.get('Content-Disposition');
            const m = disposition?.match(/filename="?([^"]+)"?/);
            const fileName = m?.[1] || `dnevnik-${toYMD(dnevnikFrom)}_${toYMD(dnevnikTo)}.pdf`;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            setShowDnevnik(false);
        } catch {
            toast.error(t('dnevnikGenerateFail'));
        } finally {
            setDnevnikBusy(false);
        }
    };

    const breadcrumbs = [
        { label: t('dashboard'), href: tenantHref('/dashboard') },
        { label: t('breadcrumb'), href: tenantHref('/journal') },
        { label: entry?.title ?? t('entryFallback') },
    ];

    if (isLoading && !entry) {
        return (
            <EntityDetailLayout loading title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }
    if (error && !entry) {
        return (
            <EntityDetailLayout error={(error as Error).message} title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }
    if (!entry) {
        return (
            <EntityDetailLayout empty={{ message: t('notFound') }} title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }

    const quantities = entry.quantities ?? [];
    const photos = entry.files ?? [];
    const locations = entry.locations ?? [];
    const equipment = entry.equipment ?? [];

    const tabs: ReadonlyArray<{ key: Tab; label: string; count?: number }> = [
        { key: 'details', label: t('tabDetails') },
        { key: 'quantities', label: t('tabQuantities'), count: quantities.length },
        { key: 'photos', label: t('tabPhotos'), count: photos.length },
    ];

    return (
        <EntityDetailLayout
            id="journal-detail-page"
            breadcrumbs={breadcrumbs}
            title={<span id="journal-title-heading">{entry.title}</span>}
            meta={
                <MetaStrip
                    items={[
                        {
                            label: t('metaType'),
                            value:
                                entry.type in LOG_ENTRY_TYPE_LABELS
                                    ? te(`logType.${entry.type}`)
                                    : String(entry.type).replace(/_/g, ' '),
                        },
                        {
                            kind: 'status' as const,
                            label: t('metaStatus'),
                            value:
                                entry.status in STATUS_BADGE
                                    ? te(`status.${entry.status}`)
                                    : entry.status,
                            variant: STATUS_BADGE[entry.status] ?? 'neutral',
                        },
                        // Provenance, not a restriction: an entry minted by a
                        // field operation is still fully editable/deletable —
                        // this just tells the farmer where it came from.
                        ...(entry.operationParcelId
                            ? [{
                                  kind: 'status' as const,
                                  label: t('metaOrigin'),
                                  value: t('originFieldOperation'),
                                  variant: 'info' as const,
                              }]
                            : []),
                    ]}
                />
            }
            actions={
                <div className="flex items-center gap-compact">

                    {entry.fieldOperation && (
                        <Button
                            variant="secondary"
                            size="sm"
                            icon={<CalendarIcon className="size-4" />}
                            onClick={() => setShowDnevnik(true)}
                            id="journal-dnevnik-btn"
                        >
                            {t('dnevnikBtn')}
                        </Button>
                    )}
                    {permissions.canWrite && (
                        <Tooltip content={t('deleteEntry')}>
                            <Button
                                variant="destructive-outline"
                                size="icon"
                                onClick={handleDeleteEntry}
                                id="delete-journal-btn"
                                aria-label={t('deleteEntry')}
                            >
                                <Trash className="size-4" />
                            </Button>
                        </Tooltip>
                    )}
                    {permissions.canWrite && (
                        <Tooltip content={t('editEntry')}>
                            <Button
                                variant="secondary"
                                size="icon"
                                onClick={() => setEditing(true)}
                                id="edit-journal-btn"
                                aria-label={t('editEntry')}
                            >
                                <Pen2 className="size-4" />
                            </Button>
                        </Tooltip>
                    )}
                </div>
            }
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={(k) => setActiveTab(k)}
        >
            {permissions.canWrite && (
                <JournalEntryModal
                    open={editing}
                    setOpen={setEditing}
                    tenantSlug={tenantSlug}
                    initial={{
                        id: entry.id,
                        type: entry.type,
                        status: entry.status,
                        occurredAt: entry.occurredAt,
                        title: entry.title,
                        notes: entry.notes,
                        quantities: quantities.map((q) => ({
                            measure: q.measure,
                            value: q.value,
                            unitId: q.unitId,
                            label: q.label,
                        })),
                        locationIds: locations
                            .map((l) => l.locationId ?? l.location?.id)
                            .filter((id): id is string => Boolean(id)),
                        // Seeded because updateLogEntry REPLACES these sets —
                        // omitting them would silently clear the entry's
                        // equipment links on every edit.
                        equipmentIds: equipment
                            .map((e) => e.assetId ?? e.asset?.id ?? e.equipmentId ?? e.equipment?.id)
                            .filter((id): id is string => Boolean(id)),
                        costAmount: entry.costAmount ?? null,
                    }}
                    onSaved={() => void mutate()}
                />
            )}

            {activeTab === 'details' && (
                <div className={cn(cardVariants(), 'space-y-default')} id="journal-detail">
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-default">
                        <div>
                            <Eyebrow>{t('occurred')}</Eyebrow>
                            <p className="text-sm">{formatDateTime(entry.occurredAt)}</p>
                        </div>
                        <div>
                            <Eyebrow>{t('locations')}</Eyebrow>
                            <p className="text-sm">
                                {locations.length
                                    ? locations.map((l) => l.location?.name).filter(Boolean).join(', ')
                                    : '—'}
                            </p>
                        </div>
                        <div>
                            <Eyebrow>{t('equipment')}</Eyebrow>
                            <p className="text-sm">
                                {equipment.length
                                    ? equipment.map((e) => e.asset?.name ?? e.equipment?.name).filter(Boolean).join(', ')
                                    : '—'}
                            </p>
                        </div>
                        <div>
                            <Eyebrow>{t('cost')}</Eyebrow>
                            <p className="text-sm tabular-nums">
                                {entry.costAmount != null
                                    ? `${Number(entry.costAmount)}${entry.costCurrency ? ` ${entry.costCurrency}` : ''}`
                                    : '—'}
                            </p>
                        </div>
                    </div>

                    <div>
                        <Eyebrow>{t('notes')}</Eyebrow>
                        {entry.notes ? (
                            <div
                                className="prose prose-sm prose-invert max-w-none text-sm"
                                // Notes are sanitized server-side on write
                                // (sanitizeRichTextHtml at the usecase boundary);
                                // re-sanitized here client-side as defence-in-depth,
                                // mirroring the policy-detail HTML render.
                                dangerouslySetInnerHTML={{ __html: sanitizeRichTextHtml(entry.notes) }}
                            />
                        ) : (
                            <p className="text-sm text-content-muted">—</p>
                        )}
                    </div>

                    <div className="grid grid-cols-2 gap-default border-t border-border-default/50 pt-4">
                        <div>
                            <Eyebrow>{t('created')}</Eyebrow>
                            <p className="text-sm text-content-muted">{formatDateTime(entry.createdAt)}</p>
                        </div>
                        <div>
                            <Eyebrow>{t('updated')}</Eyebrow>
                            <p className="text-sm text-content-muted">{formatDateTime(entry.updatedAt)}</p>
                        </div>
                    </div>
                </div>
            )}

            {activeTab === 'quantities' && (
                <div className={cn(cardVariants(), 'space-y-default')} id="journal-quantities">
                    <Heading level={3}>{t('quantitiesHeading')}</Heading>
                    {quantities.length === 0 ? (
                        <EmptyState
                            size="sm"
                            variant="no-records"
                            title={t('noQuantitiesTitle')}
                            description={t('quantitiesEmptyDescription')}
                        />
                    ) : (
                        <ul className="divide-y divide-border-subtle">
                            {quantities.map((q) => (
                                <li key={q.id} className="flex items-center justify-between py-2">
                                    <span className="text-sm">
                                        <StatusBadge variant="neutral" size="sm">
                                            {te(`measure.${q.measure}`)}
                                        </StatusBadge>{' '}
                                        {q.label || '—'}
                                    </span>
                                    <span className="font-mono text-sm tabular-nums text-content-emphasis">
                                        {q.value} {q.unit?.symbol ?? ''}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {activeTab === 'photos' && (
                <div className="space-y-default">
                    {entry.attributesJson?.pestId && (
                        <PestSuggestionCard data={entry.attributesJson.pestId} />
                    )}
                    <JournalPhotosTab
                        entryId={entryId}
                        photos={photos}
                        apiUrl={apiUrl}
                        canWrite={permissions.canWrite}
                        onChanged={() => void mutate()}
                    />
                </div>
            )}

            {/* БАБХ ДНЕВНИК (PDF) — manual generation for this operation's location. */}
            <Modal
                showModal={showDnevnik}
                setShowModal={(v) => { if (!v) setShowDnevnik(false); }}
                size="sm"
                title={t('dnevnikTitle')}
                description={t('dnevnikDescription')}
            >
                <Modal.Header title={t('dnevnikTitle')} description={t('dnevnikDescription')} />
                <Modal.Body>
                    <div className="flex flex-col gap-default sm:flex-row">
                        <FormField label={t('dnevnikFrom')}>
                            <DatePicker value={dnevnikFrom} onChange={(d) => d && setDnevnikFrom(d)} />
                        </FormField>
                        <FormField label={t('dnevnikTo')}>
                            <DatePicker value={dnevnikTo} onChange={(d) => d && setDnevnikTo(d)} />
                        </FormField>
                    </div>
                </Modal.Body>
                <Modal.Actions>
                    <Button variant="secondary" size="sm" type="button" onClick={() => setShowDnevnik(false)}>{t('dnevnikCancel')}</Button>
                    <Button variant="primary" size="sm" type="button" loading={dnevnikBusy} disabled={dnevnikBusy} onClick={() => void generateDnevnik()}>{t('dnevnikDownload')}</Button>
                </Modal.Actions>
            </Modal>
        </EntityDetailLayout>
    );
}
