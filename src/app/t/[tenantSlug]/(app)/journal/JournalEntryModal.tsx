'use client';

/**
 * JournalEntryModal — create / edit a field-journal entry.
 *
 * Carries the full LogEntry authoring surface: type, status, date,
 * title, TipTap rich-text notes, farmOS quantity lines (measure +
 * value + unit + label), and Location links. Mirrors the Modal.Form
 * shell + unsaved-changes guard used by NewAssetModal / NewLocationModal.
 *
 * The RichTextEditor (Tiptap + ProseMirror) is lazy-loaded via
 * next/dynamic so its ~200KB chunk only lands when the modal opens.
 */

import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import dynamic from 'next/dynamic';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { apiPatch } from '@/lib/api-client';
import { useOfflineSync, type OfflineSync } from '@/lib/offline/use-offline-sync';
import { Button } from '@/components/ui/button';
import { Plus, Trash } from '@/components/ui/icons/nucleo';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Checkbox } from '@/components/ui/checkbox';
import { DatePicker } from '@/components/ui/date-picker';
import { SkeletonCard } from '@/components/ui/skeleton';
import {
    LOG_ENTRY_TYPE_LABELS,
    LOG_ENTRY_STATUS_LABELS,
} from './filter-defs';
import { canConvert, convert } from '@/lib/units/unit-conversion';
import { useTranslations } from 'next-intl';

const RichTextEditor = dynamic(
    () => import('@/components/ui/RichTextEditor').then((m) => m.RichTextEditor),
    { ssr: false, loading: () => <SkeletonCard lines={4} /> },
);

const QUANTITY_MEASURES = ['COUNT', 'WEIGHT', 'VOLUME', 'AREA', 'LENGTH', 'RATE', 'OTHER'] as const;
type QuantityMeasure = (typeof QUANTITY_MEASURES)[number];

interface UnitOption {
    id: string;
    name: string;
    symbol: string;
    measure: string;
}

interface LocationOption {
    id: string;
    name: string;
}

interface EquipmentOption {
    id: string;
    name: string;
    make?: string | null;
    model?: string | null;
}

interface ItemOption {
    id: string;
    name: string;
    category: string;
    /** The item's default unit. Its `key` decides whether a harvest
     *  quantity can be converted to tonnes for a yield record — crates
     *  ('each') and volumes ('l') cannot be. */
    defaultUnit?: { key: string; symbol: string } | null;
}

interface QuantityRow {
    measure: QuantityMeasure;
    value: string;
    unitId: string;
    label: string;
}

/**
 * Optional harvest-output payload (HARVEST entries only). The server mints a
 * HARVEST_IN lot of `itemId` and records genealogy when this is present.
 */
interface HarvestPayload {
    itemId: string;
    quantity: number;
    lotCode?: string | null;
    /** Bin/store the minted lot is placed in — what ties it to a grain bin. */
    locationId?: string | null;
    /** Also record the harvest as production (a linked YieldRecord). */
    recordYield?: boolean;
}

interface JournalSubmitBody {
    type: string;
    status: string;
    occurredAt: string | null;
    title: string;
    notes: string | null;
    quantities: Array<{ measure: QuantityMeasure; value: number; unitId: string; label: string | null }>;
    locationIds: string[];
    equipmentIds: string[];
    costAmount?: number | null;
    costCurrency?: string | null;
    harvest?: HarvestPayload;
}

export interface JournalEntryInitial {
    id?: string;
    type?: string;
    status?: string;
    occurredAt?: string | null;
    title?: string;
    notes?: string | null;
    quantities?: Array<{ measure: string; value: number | string; unitId: string; label?: string | null }>;
    locationIds?: string[];
    equipmentIds?: string[];
    costAmount?: number | string | null;
    costCurrency?: string | null;
}

/**
 * The just-authored entry, surfaced for an optimistic list row so a queued
 * (offline) create shows immediately — reconciled by the server row on the
 * next refetch. `id` is a client temp id until the outbox delivers.
 */
export interface OptimisticJournalEntry {
    id: string;
    type: string;
    status: string;
    title: string;
    occurredAt: string;
    notes: string | null;
}

export interface JournalEntryModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    tenantSlug: string;
    /** When provided the modal is in EDIT mode and PATCHes this entry. */
    initial?: JournalEntryInitial;
    /** EDIT-mode save callback — receives the server-saved entry id. */
    onSaved?: (entry: { id: string }) => void;
    /**
     * CREATE-mode callback. `queued` is true when the entry was enqueued
     * offline (delivers on reconnect, deduped by Idempotency-Key). The
     * optimistic entry lets the parent prepend a list row immediately.
     */
    onCreated?: (queued: boolean, optimistic: OptimisticJournalEntry) => void;
    /**
     * GRAIN module on. Gates the harvest section's "also record as yield"
     * option — recording production is a GRAIN concept, so a tenant without
     * the module is never offered it. Resolved server-side (page.tsx),
     * because the client-readable module endpoint is admin-gated.
     */
    grainEnabled?: boolean;
    /**
     * Shared offline-sync submit from the parent, so the parent's
     * `OfflineSyncBar` pending count reflects a queued create immediately.
     * Falls back to the modal's own hook when omitted (other call sites).
     */
    offlineSubmit?: OfflineSync['submit'];
}


export function JournalEntryModal({ open, setOpen, tenantSlug, initial, onSaved, onCreated, offlineSubmit, grainEnabled }: JournalEntryModalProps) {
    const buildUrl = useTenantApiUrl();
    const localSync = useOfflineSync();
    // Prefer the parent's shared submit (keeps its OfflineSyncBar pending count
    // live); fall back to this modal's own hook at other call sites.
    const enqueueSubmit = offlineSubmit ?? localSync.submit;
    const t = useTranslations('journal.entryModal');
    const te = useTranslations('journalEnums');
    // Authoring dropdowns are localized from journalEnums — the English
    // LOG_ENTRY_*_LABELS maps stay only as the value source.
    const TYPE_OPTIONS: ComboboxOption[] = useMemo(
        () => Object.keys(LOG_ENTRY_TYPE_LABELS).map((value) => ({ value, label: te(`logType.${value}`) })),
        [te],
    );
    const STATUS_OPTIONS: ComboboxOption[] = useMemo(
        () => Object.keys(LOG_ENTRY_STATUS_LABELS).map((value) => ({ value, label: te(`status.${value}`) })),
        [te],
    );
    const MEASURE_OPTIONS: ComboboxOption[] = useMemo(
        () => QUANTITY_MEASURES.map((m) => ({ value: m, label: te(`measure.${m}`) })),
        [te],
    );
    const isEdit = !!initial?.id;

    // Catalogs for the pickers.
    // Units are a slow-changing catalog — relax SWR revalidation.
    const { data: units } = useTenantSWR<UnitOption[]>(open ? '/units' : null, {
        revalidateOnFocus: false,
        dedupingInterval: 60_000,
    });
    const { data: locations } = useTenantSWR<LocationOption[]>(open ? '/locations' : null);
    // Items catalog — backs the optional harvest-output picker (HARVEST only).
    const { data: items } = useTenantSWR<ItemOption[]>(open ? '/items' : null);
    // Storage destinations for the minted harvest lot. Deliberately a separate
    // read from the `/locations` above: that one backs the field-block link
    // (growing areas), this one must offer only places stock can sit, since a
    // lot receipted against a FIELD is invisible to every bin view.
    const { data: storageLocations } = useTenantSWR<LocationOption[]>(
        open ? '/locations?kind=BIN,STORAGE,BARN,WAREHOUSE' : null,
        { revalidateOnFocus: false, dedupingInterval: 60_000 },
    );
    // Equipment catalog — backs the multi-picker (schemas already accepted
    // equipmentIds; the detail page already displayed them).
    const { data: equipment } = useTenantSWR<EquipmentOption[]>(open ? '/equipment' : null);

    // ── Form state ──
    const [type, setType] = useState<string>(initial?.type ?? 'ACTIVITY');
    const [status, setStatus] = useState<string>(initial?.status ?? 'DONE');
    const [occurredAt, setOccurredAt] = useState<Date | null>(
        initial?.occurredAt ? new Date(initial.occurredAt) : new Date(),
    );
    const [title, setTitle] = useState(initial?.title ?? '');
    const [notes, setNotes] = useState(initial?.notes ?? '');
    const [quantities, setQuantities] = useState<QuantityRow[]>(
        (initial?.quantities ?? []).map((q) => ({
            measure: (q.measure as QuantityMeasure) ?? 'COUNT',
            value: String(q.value ?? ''),
            unitId: q.unitId ?? '',
            label: q.label ?? '',
        })),
    );
    const [locationIds, setLocationIds] = useState<string[]>(initial?.locationIds ?? []);
    const [equipmentIds, setEquipmentIds] = useState<string[]>(initial?.equipmentIds ?? []);
    const [costAmount, setCostAmount] = useState<string>(
        initial?.costAmount != null ? String(initial.costAmount) : '',
    );
    // Harvest-output state — only consumed when type === 'HARVEST'. Editing an
    // existing entry never re-mints a lot, so these reset to empty on open.
    const [harvestItemId, setHarvestItemId] = useState<string>('');
    const [harvestQty, setHarvestQty] = useState<string>('');
    const [harvestLotCode, setHarvestLotCode] = useState<string>('');
    const [harvestLocationId, setHarvestLocationId] = useState<string>('');
    // Harvest → yield reconciliation. A HARVEST entry can record the
    // PRODUCTION side too, so the yield figure and the stock come from ONE
    // entry instead of two that never reconcile. Pre-checked (the common
    // intent on a grain farm) but always visible with its derived tonnage
    // shown, so it is opt-out rather than silent.
    const [recordYield, setRecordYield] = useState(true);
    const [dirty, setDirty] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Re-seed the form whenever the modal (re)opens with a new `initial`.
    /* eslint-disable react-hooks/set-state-in-effect -- intentional form re-seed on open. */
    useEffect(() => {
        if (!open) return;
        setType(initial?.type ?? 'ACTIVITY');
        setStatus(initial?.status ?? 'DONE');
        setOccurredAt(initial?.occurredAt ? new Date(initial.occurredAt) : new Date());
        setTitle(initial?.title ?? '');
        setNotes(initial?.notes ?? '');
        setQuantities(
            (initial?.quantities ?? []).map((q) => ({
                measure: (q.measure as QuantityMeasure) ?? 'COUNT',
                value: String(q.value ?? ''),
                unitId: q.unitId ?? '',
                label: q.label ?? '',
            })),
        );
        setLocationIds(initial?.locationIds ?? []);
        setEquipmentIds(initial?.equipmentIds ?? []);
        setCostAmount(initial?.costAmount != null ? String(initial.costAmount) : '');
        setHarvestItemId('');
        setHarvestQty('');
        setHarvestLotCode('');
        setHarvestLocationId('');
        setDirty(false);
        setError(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, initial?.id]);
    /* eslint-enable react-hooks/set-state-in-effect */

    const unitOptions: ComboboxOption[] = useMemo(
        () => (units ?? []).map((u) => ({ value: u.id, label: `${u.name} (${u.symbol})` })),
        [units],
    );
    const locationOptions: ComboboxOption[] = useMemo(
        () => (locations ?? []).map((l) => ({ value: l.id, label: l.name })),
        [locations],
    );
    const storageOptions: ComboboxOption[] = useMemo(
        () => (storageLocations ?? []).map((l) => ({ value: l.id, label: l.name })),
        [storageLocations],
    );
    const equipmentOptions: ComboboxOption[] = useMemo(
        () => (equipment ?? []).map((e) => ({
            value: e.id,
            label: e.make || e.model ? `${e.name} (${[e.make, e.model].filter(Boolean).join(' ')})` : e.name,
        })),
        [equipment],
    );
    // Harvest item options — surface HARVESTED_PRODUCE first (the expected
    // output category) but keep every item selectable.
    const harvestItemOptions: ComboboxOption[] = useMemo(() => {
        const all = items ?? [];
        const produce = all.filter((i) => i.category === 'HARVESTED_PRODUCE');
        const rest = all.filter((i) => i.category !== 'HARVESTED_PRODUCE');
        return [...produce, ...rest].map((i) => ({ value: i.id, label: i.name }));
    }, [items]);

    const markDirty = () => setDirty(true);

    const addQuantity = () => {
        setQuantities((qs) => [...qs, { measure: 'COUNT', value: '', unitId: '', label: '' }]);
        markDirty();
    };
    const updateQuantity = (i: number, patch: Partial<QuantityRow>) => {
        setQuantities((qs) => qs.map((q, idx) => (idx === i ? { ...q, ...patch } : q)));
        markDirty();
    };
    const removeQuantity = (i: number) => {
        setQuantities((qs) => qs.filter((_, idx) => idx !== i));
        markDirty();
    };

    const canSubmit = title.trim().length > 0 && !submitting && (
        quantities.length === 0 ||
        quantities.every((q) => q.unitId && q.value.trim() !== '' && !Number.isNaN(Number(q.value)))
    );

    // Tonnage for the optional yield record. Derivable ONLY when the item's
    // default unit is a mass: `canConvert` is dimensional, so crates
    // ('each') or a volume ('l') yield null here rather than a fabricated
    // number in a production total. Mirrors the server's own gate in
    // `recordYieldFromHarvest`, which refuses the same cases.
    const yieldTonnes = useMemo<number | null>(() => {
        if (type !== 'HARVEST' || !grainEnabled) return null;
        const unitKey = (items ?? []).find((i) => i.id === harvestItemId)?.defaultUnit?.key;
        const qty = Number(harvestQty);
        if (!unitKey || !canConvert(unitKey, 't')) return null;
        if (harvestQty.trim() === '' || Number.isNaN(qty) || qty <= 0) return null;
        return Math.round(convert(qty, unitKey, 't') * 1e3) / 1e3;
    }, [type, grainEnabled, items, harvestItemId, harvestQty]);

    // The harvest payload rides along only on a HARVEST entry that actually
    // names an output item + quantity. Everything else (lot code) is optional;
    // a HARVEST entry with no item set still submits with no harvest object.
    const harvestPayload = useMemo<HarvestPayload | null>(() => {
        if (type !== 'HARVEST') return null;
        const qty = Number(harvestQty);
        if (!harvestItemId || harvestQty.trim() === '' || Number.isNaN(qty) || qty <= 0) {
            return null;
        }
        return {
            itemId: harvestItemId,
            quantity: qty,
            lotCode: harvestLotCode.trim() || null,
            locationId: harvestLocationId || null,
            // Only ever sent when the tonnage is genuinely derivable, so the
            // server never has to refuse a request the UI implied would work.
            ...(recordYield && yieldTonnes != null ? { recordYield: true } : {}),
        };
    }, [type, harvestItemId, harvestQty, harvestLotCode, harvestLocationId, recordYield, yieldTonnes]);

    const submit = async () => {
        setSubmitting(true);
        setError(null);
        try {
            const body: JournalSubmitBody = {
                type,
                status,
                occurredAt: occurredAt ? occurredAt.toISOString() : null,
                title: title.trim(),
                notes: notes.trim() ? notes : null,
                quantities: quantities.map((q) => ({
                    measure: q.measure,
                    value: Number(q.value),
                    unitId: q.unitId,
                    label: q.label.trim() || null,
                })),
                locationIds,
                equipmentIds,
                costAmount: costAmount.trim() ? Number(costAmount) : null,
            };
            if (harvestPayload) body.harvest = harvestPayload;
            if (isEdit && initial?.id) {
                const res = await apiPatch<{ entry: { id: string } }>(
                    buildUrl(`/journal/${initial.id}`),
                    body,
                );
                setDirty(false);
                setOpen(false);
                onSaved?.(res.entry);
            } else {
                // CREATE goes through the offline outbox: online it POSTs
                // immediately; offline (or on a transient 5xx) it queues and the
                // service worker replays it on reconnect — carrying its outbox
                // id as the Idempotency-Key, so the server dedupes the delivery.
                const result = await enqueueSubmit({
                    url: buildUrl('/journal'),
                    method: 'POST',
                    body,
                    label: body.title || t('createEntry'),
                });
                setDirty(false);
                setOpen(false);
                onCreated?.(result === 'queued', {
                    // Client temp id — replaced by the server row on refetch.
                    id: `optimistic-${occurredAt?.getTime() ?? ''}-${title.trim()}`,
                    type: body.type,
                    status: body.status,
                    title: body.title,
                    occurredAt: body.occurredAt ?? new Date().toISOString(),
                    notes: body.notes,
                });
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to save entry');
        } finally {
            setSubmitting(false);
        }
    };

    // Unsaved-changes guard.
    //   - CREATE mode delegates to the Modal primitive's `isDirty` prop
    //     (native "Discard changes?" confirm on drag-down / backdrop /
    //     Escape) — see the `isDirty` prop on <Modal> below.
    //   - EDIT mode keeps the bespoke `window.confirm` guard (untouched).
    // Either way the explicit Cancel button calls `setOpen(false)`
    // directly to bypass the guard.
    const guardedSetOpen = useCallback<Dispatch<SetStateAction<boolean>>>(
        (next) => {
            const wantClose = typeof next === 'function' ? !next(true) : next === false;
            if (wantClose) {
                if (submitting) return;
                if (isEdit && dirty && !window.confirm(t('discardConfirm'))) {
                    return;
                }
            }
            setOpen(next);
        },
        [submitting, dirty, isEdit, setOpen],
    );
    const close = () => setOpen(false);

    const heading = isEdit ? t('editTitle') : t('newTitle');
    const description = isEdit
        ? t('editDescription')
        : t('newDescription');

    return (
        <Modal
            showModal={open}
            setShowModal={guardedSetOpen}
            size="lg"
            title={heading}
            description={description}
            preventDefaultClose={submitting}
            isDirty={!isEdit && dirty}
        >
            <Modal.Header title={heading} description={description} />
            <Modal.Form
                id="journal-entry-form"
                onSubmit={(e) => {
                    e.preventDefault();
                    void submit();
                }}
            >
                <Modal.Body>
                    {error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="journal-entry-error"
                            role="alert"
                        >
                            {error}
                        </div>
                    )}
                    <fieldset disabled={submitting} className="m-0 p-0 border-0 space-y-default">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-default">
                            <FormField label={t('fieldType')} required>
                                <Combobox
                                    options={TYPE_OPTIONS}
                                    selected={TYPE_OPTIONS.find((o) => o.value === type) ?? null}
                                    setSelected={(o) => {
                                        setType(o?.value ?? 'ACTIVITY');
                                        markDirty();
                                    }}
                                    placeholder={t('typePlaceholder')}
                                    aria-label={t('typeAria')}
                                    matchTriggerWidth
                                />
                            </FormField>
                            <FormField label={t('fieldStatus')}>
                                <Combobox
                                    options={STATUS_OPTIONS}
                                    selected={STATUS_OPTIONS.find((o) => o.value === status) ?? null}
                                    setSelected={(o) => {
                                        setStatus(o?.value ?? 'DONE');
                                        markDirty();
                                    }}
                                    placeholder={t('statusPlaceholder')}
                                    aria-label={t('statusAria')}
                                    matchTriggerWidth
                                />
                            </FormField>
                            <FormField label={t('fieldDate')}>
                                <DatePicker
                                    value={occurredAt}
                                    onChange={(d) => {
                                        setOccurredAt(d);
                                        markDirty();
                                    }}
                                    placeholder={t('datePlaceholder')}
                                />
                            </FormField>
                        </div>

                        <FormField label={t('fieldTitle')} required>
                            <Input
                                value={title}
                                onChange={(e) => {
                                    setTitle(e.target.value);
                                    markDirty();
                                }}
                                placeholder={t('titlePlaceholder')}
                                id="journal-entry-title"
                            />
                        </FormField>

                        <FormField label={t('fieldNotes')}>
                            <RichTextEditor
                                value={notes}
                                contentType="HTML"
                                onChange={(v) => {
                                    setNotes(v);
                                    markDirty();
                                }}
                                placeholder={t('notesPlaceholder')}
                                minHeightPx={160}
                            />
                        </FormField>

                        <FormField label={t('fieldLocations')}>
                            <Combobox
                                multiple
                                options={locationOptions}
                                selected={locationOptions.filter((o) => locationIds.includes(o.value))}
                                setSelected={(opts) => {
                                    setLocationIds(opts.map((o) => o.value));
                                    markDirty();
                                }}
                                placeholder={locationOptions.length ? t('locationsPlaceholder') : t('locationsEmpty')}
                                aria-label={t('locationsAria')}
                                matchTriggerWidth
                            />
                        </FormField>

                        <FormField label={t('fieldEquipment')}>
                            <Combobox
                                multiple
                                options={equipmentOptions}
                                selected={equipmentOptions.filter((o) => equipmentIds.includes(o.value))}
                                setSelected={(opts) => {
                                    setEquipmentIds(opts.map((o) => o.value));
                                    markDirty();
                                }}
                                placeholder={equipmentOptions.length ? t('equipmentPlaceholder') : t('equipmentEmpty')}
                                aria-label={t('equipmentAria')}
                                matchTriggerWidth
                            />
                        </FormField>

                        <FormField label={t('fieldCost')} hint={t('costHint')}>
                            <Input
                                id="journal-cost-input"
                                inputMode="decimal"
                                value={costAmount}
                                onChange={(e) => { setCostAmount(e.target.value); markDirty(); }}
                                placeholder={t('costPlaceholder')}
                            />
                        </FormField>

                        {/* Harvest output — HARVEST entries only. Optional: leave the
                            item blank and the entry submits with no lot minted. */}
                        {type === 'HARVEST' && (
                            <div
                                className="space-y-default rounded-lg border border-border-subtle bg-bg-default p-3"
                                id="journal-harvest-section"
                            >
                                <div>
                                    <span className="text-sm font-medium text-content-emphasis">{t('harvestOutput')}</span>
                                    <p className="mt-1 text-xs text-content-muted">
                                        {t('harvestHint')}
                                    </p>
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-default">
                                    <FormField label={t('harvestedItem')}>
                                        <Combobox
                                            options={harvestItemOptions}
                                            selected={harvestItemOptions.find((o) => o.value === harvestItemId) ?? null}
                                            setSelected={(o) => {
                                                setHarvestItemId(o?.value ?? '');
                                                markDirty();
                                            }}
                                            placeholder={harvestItemOptions.length ? t('productPlaceholder') : t('productEmpty')}
                                            aria-label={t('harvestedItemAria')}
                                            matchTriggerWidth
                                        />
                                    </FormField>
                                    <FormField label={t('quantity')}>
                                        <Input
                                            inputMode="decimal"
                                            value={harvestQty}
                                            onChange={(e) => {
                                                setHarvestQty(e.target.value.replace(/[^0-9.]/g, ''));
                                                markDirty();
                                            }}
                                            placeholder={t('quantityPlaceholder')}
                                            aria-label={t('harvestQtyAria')}
                                            id="journal-harvest-qty"
                                        />
                                    </FormField>
                                </div>
                                <FormField label={t('lotCode')} hint={t('lotCodeHint')}>
                                    <Input
                                        value={harvestLotCode}
                                        onChange={(e) => {
                                            setHarvestLotCode(e.target.value);
                                            markDirty();
                                        }}
                                        placeholder={t('lotCodePlaceholder')}
                                        aria-label={t('lotCodeAria')}
                                    />
                                </FormField>
                                <FormField
                                    label={t('harvestDestination')}
                                    hint={t('harvestDestinationHint')}
                                >
                                    <Combobox
                                        options={storageOptions}
                                        selected={
                                            storageOptions.find((o) => o.value === harvestLocationId) ?? null
                                        }
                                        setSelected={(o) => {
                                            setHarvestLocationId(o?.value ?? '');
                                            markDirty();
                                        }}
                                        placeholder={
                                            storageOptions.length
                                                ? t('harvestDestinationPlaceholder')
                                                : t('harvestDestinationEmpty')
                                        }
                                        aria-label={t('harvestDestination')}
                                        matchTriggerWidth
                                    />
                                </FormField>

                                {/* Also record the PRODUCTION side. Before this
                                    existed, a harvest logged here produced stock
                                    but left the yield figure at zero, while a
                                    harvest typed on /grain/yield produced a
                                    tonnage with empty bins — the group total
                                    could not tell the two apart. Shown only when
                                    the tonnage is genuinely derivable; when it is
                                    not, say why instead of hiding the option. */}
                                {grainEnabled && yieldTonnes != null && (
                                    <div className="flex items-start gap-tight border-t border-border-subtle pt-3">
                                        <Checkbox
                                            id="journal-harvest-record-yield"
                                            checked={recordYield}
                                            onCheckedChange={(v) => {
                                                setRecordYield(v === true);
                                                markDirty();
                                            }}
                                        />
                                        <label htmlFor="journal-harvest-record-yield" className="cursor-pointer">
                                            <span className="text-sm text-content-default">
                                                {t('recordYieldLabel', { tonnes: yieldTonnes })}
                                            </span>
                                            <span className="mt-1 block text-xs text-content-muted">
                                                {t('recordYieldHint')}
                                            </span>
                                        </label>
                                    </div>
                                )}
                                {grainEnabled && yieldTonnes == null && harvestItemId && (
                                    <p className="border-t border-border-subtle pt-3 text-xs text-content-muted">
                                        {t('recordYieldUnavailable')}
                                    </p>
                                )}
                            </div>
                        )}

                        {/* Quantities — farmOS measure + value + unit + label lines. */}
                        <div className="space-y-default">
                            <div className="flex items-center justify-between">
                                <span className="text-sm font-medium text-content-emphasis">{t('quantities')}</span>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    icon={<Plus className="size-3.5" />}
                                    onClick={addQuantity}
                                    id="journal-add-quantity"
                                >
                                    {t('addQuantity')}
                                </Button>
                            </div>
                            {quantities.length === 0 ? (
                                <p className="text-xs text-content-muted">
                                    {t('quantitiesHint')}
                                </p>
                            ) : (
                                <div className="space-y-tight">
                                    {quantities.map((q, i) => (
                                        <div
                                            key={i}
                                            className="grid grid-cols-12 gap-tight items-end"
                                            data-testid={`journal-quantity-row-${i}`}
                                        >
                                            <div className="col-span-3">
                                                <Combobox
                                                    options={MEASURE_OPTIONS}
                                                    selected={MEASURE_OPTIONS.find((o) => o.value === q.measure) ?? null}
                                                    setSelected={(o) =>
                                                        updateQuantity(i, { measure: (o?.value as QuantityMeasure) ?? 'COUNT' })
                                                    }
                                                    aria-label={t('measureAria')}
                                                    matchTriggerWidth
                                                />
                                            </div>
                                            <div className="col-span-3">
                                                <Input
                                                    inputMode="decimal"
                                                    value={q.value}
                                                    onChange={(e) =>
                                                        updateQuantity(i, {
                                                            // Keep only number-ish characters so the
                                                            // decimal text input stays parseable.
                                                            value: e.target.value.replace(/[^0-9.\-]/g, ''),
                                                        })
                                                    }
                                                    placeholder={t('valuePlaceholder')}
                                                    aria-label={t('valueAria')}
                                                />
                                            </div>
                                            <div className="col-span-3">
                                                <Combobox
                                                    options={unitOptions}
                                                    selected={unitOptions.find((o) => o.value === q.unitId) ?? null}
                                                    setSelected={(o) => updateQuantity(i, { unitId: o?.value ?? '' })}
                                                    placeholder={t('unitPlaceholder')}
                                                    aria-label={t('unitAria')}
                                                    matchTriggerWidth
                                                />
                                            </div>
                                            <div className="col-span-2">
                                                <Input
                                                    value={q.label}
                                                    onChange={(e) => updateQuantity(i, { label: e.target.value })}
                                                    placeholder={t('labelPlaceholder')}
                                                    aria-label={t('labelAria')}
                                                />
                                            </div>
                                            <div className="col-span-1 flex justify-end">
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="icon"
                                                    onClick={() => removeQuantity(i)}
                                                    aria-label={t('removeQuantity')}
                                                >
                                                    <Trash className="size-4" />
                                                </Button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </fieldset>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        onClick={close}
                        disabled={submitting}
                        id="journal-entry-cancel"
                    >
                        {t('cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        disabled={!canSubmit}
                        loading={submitting}
                        id="journal-entry-submit"
                    >
                        {isEdit ? t('saveEntry') : t('createEntry')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
