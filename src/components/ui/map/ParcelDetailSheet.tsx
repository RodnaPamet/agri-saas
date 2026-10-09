'use client';

/**
 * ParcelDetailSheet — the single spray/field-operation screen (#3).
 *
 * Tapping a parcel (on the map or the parcels list) opens this bottom-sheet,
 * which IS the create-operation form: an exclusive Fertilizer-XOR-Product
 * input selector, dose + unit, water carrier (product only), operator,
 * application technique, note, an editable parcel-crop selector, and a running
 * total from the shared rate-calc. Submits offline-first via `useOfflineSync`
 * (queued in the outbox with no signal, flushed on reconnect). Replaces the
 * old QR block + bespoke calculator + the multi-step SprayJobWizard.
 *
 * Built on the canonical {@link Sheet} primitive (`direction="bottom"`,
 * `modal={false}` so the map toolbar stays reachable).
 */
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import useSWR from 'swr';
import { Button, buttonVariants } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { UserCombobox } from '@/components/ui/user-combobox';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useOfflineSync } from '@/lib/offline/use-offline-sync';
import { apiGet, apiPatch } from '@/lib/api-client';
import { haToDca, totalLabel, trimNumber } from '@/lib/agro/rate-calc';
import { CROP_VALUES, cropLabel, localizedCropOptions } from '@/lib/agriculture/crop-options';
import type { SoilProfile } from '@/lib/soil/types';
import type { LocationSmartDefaults } from '@/app-layer/usecases/smart-defaults';

interface ItemDTO {
    id: string;
    name: string;
    category: string;
    defaultUnit?: { id: string; symbol: string } | null;
}
interface UnitDTO {
    id: string;
    key: string;
    name: string;
    symbol: string;
    measure: string;
}
interface MeResponse {
    user?: { id?: string | null } | null;
}

export interface ParcelSheetData {
    id: string;
    name: string;
    areaHa?: number | null;
    cropType?: string | null;
    lastApplication?: { label: string; occurredAt?: string | null } | null;
    soilJson?: SoilProfile | null;
    /** Bulgarian КАИС cadastral identifier (`EKATTE.masiv.parcel`); null when absent. */
    cadastralId?: string | null;
    /** propertiesJson — carries the documentary area for the reconciliation badge. */
    properties?: unknown;
    /** Legal-entity owners from the КАИС ownership register (empty when none). */
    companyOwners?: Array<{ name: string; eik: string; rightType: string | null; subjectKind: string | null }>;
}

export interface ParcelDetailSheetProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    parcel: ParcelSheetData | null;
    locationId: string;
    /** Location smart-defaults (default unit, repeat-last) — optional. */
    smartDefaults?: LocationSmartDefaults | null;
    /** Called after a job is created (or queued offline) so the host can refresh. */
    onCreated?: (queued: boolean) => void;
    /** Called after the parcel's crop is changed inline so the host can refresh. */
    onCropChanged?: () => void;
}

type InputKind = 'PRODUCT' | 'FERTILIZER';

export function ParcelDetailSheet({
    open,
    onOpenChange,
    parcel,
    locationId,
    smartDefaults,
    onCreated,
    onCropChanged,
}: ParcelDetailSheetProps) {
    const t = useTranslations('ag.map');
    const tc = useTranslations('common');
    const tCrops = useTranslations('crops');
    // The ПРЗ labels already exist under `inventory`; borrowing them keeps one
    // spelling of «№ на регистрация на ПРЗ» rather than a second copy here.
    const tInv = useTranslations('inventory');
    const buildUrl = useTenantApiUrl();
    const { tenantSlug } = useParams<{ tenantSlug: string }>();
    const { submit } = useOfflineSync();

    const { data: items } = useTenantSWR<ItemDTO[]>('/items');
    const { data: units } = useTenantSWR<UnitDTO[]>('/units?measure=RATE', {
        revalidateOnFocus: false,
        dedupingInterval: 60_000,
    });
    const { data: me } = useSWR<MeResponse>('/api/auth/me', apiGet);

    const [kind, setKind] = useState<InputKind>('PRODUCT');
    // Free text, not a chosen id — owner decision, 2026-10-09: the product and
    // fertiliser dropdowns are gone. 22 of 24 catalogue items on the owner's
    // farm are seeded archetypes, so a picker mostly offered things #1078
    // refuses at completion.
    const [itemName, setItemName] = useState('');
    const [pppRegNo, setPppRegNo] = useState('');
    const [quarantineDays, setQuarantineDays] = useState('');
    const [dose, setDose] = useState('');
    const [waterRate, setWaterRate] = useState('');
    const [techniqueKey, setTechniqueKey] = useState('');
    const [techniqueOther, setTechniqueOther] = useState('');
    const [note, setNote] = useState('');
    // Three fields default themselves from async-loaded data (units / the
    // signed-in operator). Rather than seeding them from an effect — which
    // cascades a second render and trips `react-hooks/set-state-in-effect` —
    // each keeps only the USER'S explicit pick here and derives the effective
    // value during render (see below). Empty override ⇒ fall back to default.
    const [doseUnitIdOverride, setDoseUnitIdOverride] = useState('');
    const [waterRateUnitIdOverride, setWaterRateUnitIdOverride] = useState('');
    const [assigneeUserIdOverride, setAssigneeUserIdOverride] = useState<string | null>(null);
    const [cropValue, setCropValue] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Reset the whole form whenever a different parcel takes the sheet.
    /* eslint-disable react-hooks/set-state-in-effect -- intentional form re-seed. */
    useEffect(() => {
        setKind('PRODUCT');
        setItemName('');
        setPppRegNo('');
        setQuarantineDays('');
        setDose('');
        setDoseUnitIdOverride('');
        setWaterRate('');
        setWaterRateUnitIdOverride('');
        setTechniqueKey('');
        setTechniqueOther('');
        setNote('');
        setError(null);
        setCropValue(parcel?.cropType ?? '');
    }, [parcel?.id, parcel?.cropType]);
    /* eslint-enable react-hooks/set-state-in-effect */

    // ── Derived defaults (computed during render, never seeded via an effect) ──

    // The dose RATE unit: the location's most-recently-used unit IF it's still
    // offered, else кг/дка (kg-per-dca) — the per-decare default. A legacy
    // per-hectare smart-default is no longer in the offered list, so it falls
    // through to the decare default rather than pre-selecting kg/ha.
    const defaultDoseUnitId = useMemo(() => {
        const list = units ?? [];
        if (list.length === 0) return '';
        const smart = smartDefaults?.defaultUnitId;
        if (smart && list.some((u) => u.id === smart)) return smart;
        return (list.find((u) => u.key === 'kg-per-dca') ?? list[0])?.id ?? '';
    }, [units, smartDefaults?.defaultUnitId]);

    // The water-carrier unit defaults to л/дка (the standard tank rate) — by
    // KEY, so it survives the symbol being Bulgarian.
    const defaultWaterRateUnitId = useMemo(
        () => (units ?? []).find((u) => u.key === 'l-per-dca')?.id ?? '',
        [units],
    );

    // The operator defaults to the signed-in user once `/me` resolves. The
    // override is only ever set by an explicit pick, so this never clobbers.
    const doseUnitId = doseUnitIdOverride || defaultDoseUnitId;
    const waterRateUnitId = waterRateUnitIdOverride || defaultWaterRateUnitId;
    const assigneeUserId = assigneeUserIdOverride ?? me?.user?.id ?? null;

    /**
     * Does the typed name already exist on this farm?
     *
     * Answered CLIENT-SIDE against the `/items` the sheet already fetched, so
     * revealing the ПРЗ fields costs no request. Case-insensitive to match the
     * server, whose unique index is on `(tenantId, lower(name))` — a
     * case-sensitive check here would hide the fields for «карате зеон», the
     * server would then match the existing row, and the operator would have
     * been asked for nothing. Harmless in that direction; the opposite
     * (hiding them when the server WILL create) is the one that produces a
     * refusal, so the comparison has to agree with the constraint.
     */
    const typedNameIsNew = useMemo(() => {
        const needle = itemName.trim().toLowerCase();
        if (!needle) return false;
        return !(items ?? []).some((it) => it.name.trim().toLowerCase() === needle);
    }, [items, itemName]);

    // A NEW product is created as a PESTICIDE, and `assertPesticideIsFilable`
    // requires both fields — they print in ДНЕВНИК columns 8–9. A new
    // FERTILIZER needs neither, so the block stays hidden for that kind.
    const needsRegistration = kind === 'PRODUCT' && typedNameIsNew;
    const registrationComplete = !!pppRegNo.trim() && quarantineDays.trim() !== '';

    const unitOptions = useMemo<ComboboxOption<UnitDTO>[]>(
        () => (units ?? []).map((u) => ({ value: u.id, label: u.symbol, meta: u })),
        [units],
    );
    const cropOptions = useMemo<ComboboxOption[]>(() => {
        const localized = localizedCropOptions(tCrops);
        // Keep an imported off-catalogue crop visible as a synthetic option.
        if (cropValue && !CROP_VALUES.has(cropValue)) {
            return [{ value: cropValue, label: cropLabel(tCrops, cropValue) }, ...localized];
        }
        return localized;
    }, [cropValue, tCrops]);

    const kindOptions = useMemo<ComboboxOption[]>(
        () => [
            { value: 'PRODUCT', label: t('parcelSheet.kindProduct') },
            { value: 'FERTILIZER', label: t('parcelSheet.kindFertilizer') },
        ],
        [t],
    );

    // Curated БАБХ application-technique catalogue. 'other' reveals a
    // free-text field so any rig not listed can still be recorded.
    const techniqueLabels = useMemo<Record<string, string>>(
        () => ({
            boom: t('parcelSheet.techniqueOptions.boom'),
            ground: t('parcelSheet.techniqueOptions.ground'),
            airblast: t('parcelSheet.techniqueOptions.airblast'),
            knapsack: t('parcelSheet.techniqueOptions.knapsack'),
            spreader: t('parcelSheet.techniqueOptions.spreader'),
            drone: t('parcelSheet.techniqueOptions.drone'),
            other: t('parcelSheet.techniqueOptions.other'),
        }),
        [t],
    );
    const techniqueOptions = useMemo<ComboboxOption[]>(
        () =>
            (['boom', 'ground', 'airblast', 'knapsack', 'spreader', 'drone', 'other'] as const).map(
                (k) => ({ value: k, label: techniqueLabels[k] }),
            ),
        [techniqueLabels],
    );
    // Persisted verbatim (БАБХ record): the localized label for a preset,
    // or the typed text for 'other' — preserving the free-text contract.
    const applicationTechnique =
        techniqueKey === 'other'
            ? techniqueOther.trim() || null
            : techniqueKey
              ? techniqueLabels[techniqueKey] ?? null
              : null;

    const area = parcel?.areaHa ?? null;
    const areaHa = area ?? 0;
    const doseNumber = Number(dose);
    const doseValid = dose.trim() !== '' && Number.isFinite(doseNumber) && doseNumber > 0;
    const waterNumber = Number(waterRate);
    const waterValid = waterRate.trim() !== '' && Number.isFinite(waterNumber) && waterNumber > 0;
    const selectedUnit = unitOptions.find((o) => o.value === doseUnitId)?.meta ?? null;
    const selectedWaterUnit = unitOptions.find((o) => o.value === waterRateUnitId)?.meta ?? null;

    const areaSummary =
        areaHa > 0 ? t('parcelSheet.areaDca', { dca: trimNumber(haToDca(areaHa)) }) : null;
    const inputTotal =
        doseValid && selectedUnit && areaHa > 0 ? totalLabel(doseNumber, selectedUnit.symbol, areaHa) : null;
    const waterTotal =
        kind === 'PRODUCT' && waterValid && selectedWaterUnit && areaHa > 0
            ? totalLabel(waterNumber, selectedWaterUnit.symbol, areaHa)
            : null;

    const canSubmit =
        !!parcel &&
        !!itemName.trim() &&
        doseValid &&
        !!doseUnitId &&
        !!assigneeUserId &&
        // Blocked in the form rather than refused by the server: the operator
        // is standing in a field, and PESTICIDE_REGULATORY_FIELDS_REQUIRED
        // arriving after submit is the "refused at the worst moment" shape this
        // whole change exists to remove.
        (!needsRegistration || registrationComplete) &&
        !submitting;

    const onCropChange = async (value: string) => {
        if (!parcel || value === cropValue) return;
        setCropValue(value);
        try {
            await apiPatch(buildUrl(`/locations/${locationId}/parcels/${parcel.id}`), { cropType: value || null });
            onCropChanged?.();
        } catch {
            // Non-blocking — the crop edit is a side action; surface nothing loud.
            setCropValue(parcel.cropType ?? '');
        }
    };

    const doSubmit = async () => {
        if (!canSubmit || !parcel) return;
        setSubmitting(true);
        setError(null);
        try {
            const isFertilizer = kind === 'FERTILIZER';
            const result = await submit({
                url: buildUrl(`/locations/${locationId}/operations`),
                method: 'POST',
                body: {
                    operationType: isFertilizer ? 'FERTILIZE' : 'SPRAY',
                    assigneeUserId,
                    parcelIds: [parcel.id],
                    ...(isFertilizer
                        ? { fertilizerName: itemName.trim(), fertilizerDoseValue: doseNumber, fertilizerDoseUnitId: doseUnitId }
                        : {
                              productName: itemName.trim(),
                              // Sent only when the name is new. On a match the
                              // server ignores it — an operation payload must
                              // not silently rewrite a stored ПРЗ № — so
                              // omitting it keeps the request honest about what
                              // it is asking for.
                              ...(needsRegistration
                                  ? {
                                        newProductRegistration: {
                                            pppRegistrationNo: pppRegNo.trim(),
                                            quarantinePeriodDays: Number(quarantineDays),
                                        },
                                    }
                                  : {}),
                              doseValue: doseNumber,
                              doseUnitId,
                              waterRateValue: waterValid ? waterNumber : null,
                              waterRateUnitId: waterValid ? waterRateUnitId : null,
                          }),
                    applicationTechnique,
                    targetNote: note.trim() || null,
                },
                label: t('parcelSheet.createOperation'),
            });
            onOpenChange(false);
            onCreated?.(result === 'queued');
        } catch (err) {
            setError(err instanceof Error ? err.message : t('parcelSheet.createFailed'));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Sheet
            open={open}
            onOpenChange={onOpenChange}
            direction="bottom"
            modal={false}
            title={parcel?.name ?? t('parcel')}
            description={t('parcelSheet.description')}
        >
            <Sheet.Header title={parcel?.name ?? t('parcel')} />
            <Sheet.Body className="space-y-section">
                {error && (
                    <div role="alert" className="rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error">
                        {error}
                    </div>
                )}

                {/* Parcel summary + editable crop. */}
                <dl className="grid grid-cols-2 gap-default text-sm">
                    <div>
                        <dt className="text-content-muted">{t('parcelSheet.area')}</dt>
                        <dd className="font-medium" data-testid="parcel-sheet-area">
                            {areaSummary ?? '—'}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-content-muted">{t('parcelSheet.crop')}</dt>
                        <dd data-testid="parcel-sheet-crop">
                            <Combobox
                                options={cropOptions}
                                selected={cropOptions.find((o) => o.value === cropValue) ?? null}
                                setSelected={(o) => void onCropChange(o?.value ?? '')}
                                placeholder={t('parcelSheet.selectCrop')}
                                aria-label={t('parcelSheet.crop')}
                                matchTriggerWidth
                            />
                        </dd>
                    </div>
                </dl>

                {/* The create-operation form — one exclusive input kind. Only
                    mounted with a parcel so the operator picker (react-query)
                    never renders while the sheet is closed. */}
                {parcel && (
                <div className="space-y-default rounded-lg border border-border-subtle p-4">
                    <p className="text-sm font-medium text-content-emphasis">{t('parcelSheet.newOperation')}</p>

                    <FormField label={t('parcelSheet.inputKind')}>
                        <ToggleGroup
                            size="sm"
                            ariaLabel={t('parcelSheet.inputKind')}
                            selected={kind}
                            selectAction={(v) => {
                                setKind(v as InputKind);
                                setItemName('');
                                setPppRegNo('');
                                setQuarantineDays('');
                            }}
                            options={kindOptions}
                        />
                    </FormField>

                    <FormField label={kind === 'FERTILIZER' ? t('parcelSheet.fertilizer') : t('parcelSheet.product')} required>
                        <Input
                            id="parcel-sheet-item-name"
                            value={itemName}
                            onChange={(e) => setItemName(e.target.value)}
                            placeholder={
                                kind === 'FERTILIZER'
                                    ? t('parcelSheet.typeFertilizer')
                                    : t('parcelSheet.typeProduct')
                            }
                            aria-label={kind === 'FERTILIZER' ? t('parcelSheet.fertilizer') : t('parcelSheet.product')}
                        />
                    </FormField>

                    {/* Shown only for a product name this farm does not have
                        yet. A new product is created as a PESTICIDE and cannot
                        be saved without these two — they are ДНЕВНИК columns
                        8–9 and the earliest-harvest date. Asking here rather
                        than letting the server refuse keeps the operator from
                        being stopped mid-field by
                        PESTICIDE_REGULATORY_FIELDS_REQUIRED. */}
                    {needsRegistration && (
                        <div className="grid grid-cols-2 gap-default">
                            <FormField label={tInv('pppRegNo')} required>
                                <Input
                                    id="parcel-sheet-ppp-reg"
                                    value={pppRegNo}
                                    onChange={(e) => setPppRegNo(e.target.value)}
                                    aria-label={tInv('pppRegNo')}
                                />
                            </FormField>
                            <FormField label={tInv('quarantineDays')} required>
                                <Input
                                    id="parcel-sheet-quarantine"
                                    inputMode="numeric"
                                    value={quarantineDays}
                                    onChange={(e) => setQuarantineDays(e.target.value)}
                                    aria-label={tInv('quarantineDays')}
                                />
                            </FormField>
                        </div>
                    )}

                    <div className="grid grid-cols-2 gap-default">
                        <FormField label={t('parcelSheet.dose')} required>
                            <Input
                                inputMode="decimal"
                                value={dose}
                                onChange={(e) => setDose(e.target.value)}
                                placeholder={t('parcelSheet.dosePlaceholder')}
                                id="parcel-sheet-dose"
                            />
                        </FormField>
                        <FormField label={t('parcelSheet.unit')} required>
                            <Combobox
                                options={unitOptions}
                                selected={unitOptions.find((o) => o.value === doseUnitId) ?? null}
                                setSelected={(o) => setDoseUnitIdOverride(o?.value ?? '')}
                                placeholder={t('parcelSheet.unit')}
                                aria-label={t('parcelSheet.unit')}
                                matchTriggerWidth
                            />
                        </FormField>
                    </div>

                    {inputTotal && (
                        <p className="text-sm text-content-muted" aria-live="polite" data-testid="parcel-sheet-total">
                            {t('parcelSheet.totalNeeded', { total: inputTotal })}
                        </p>
                    )}

                    {kind === 'PRODUCT' && (
                        <div className="grid grid-cols-2 gap-default">
                            <FormField label={t('parcelSheet.water')} hint={t('parcelSheet.waterHint')}>
                                <Input
                                    inputMode="decimal"
                                    value={waterRate}
                                    onChange={(e) => setWaterRate(e.target.value)}
                                    placeholder={t('parcelSheet.dosePlaceholder')}
                                    id="parcel-sheet-water"
                                />
                            </FormField>
                            <FormField label={t('parcelSheet.unit')}>
                                <Combobox
                                    options={unitOptions}
                                    selected={unitOptions.find((o) => o.value === waterRateUnitId) ?? null}
                                    setSelected={(o) => setWaterRateUnitIdOverride(o?.value ?? '')}
                                    placeholder={t('parcelSheet.unit')}
                                    aria-label={t('parcelSheet.waterUnit')}
                                    matchTriggerWidth
                                />
                            </FormField>
                        </div>
                    )}
                    {waterTotal && (
                        <p className="text-xs text-content-subtle" aria-live="polite">
                            {t('parcelSheet.waterNeeded', { total: waterTotal })}
                        </p>
                    )}

                    <FormField label={t('parcelSheet.operator')} required>
                        <UserCombobox
                            id="parcel-sheet-operator"
                            name="assigneeUserId"
                            tenantSlug={tenantSlug}
                            selectedId={assigneeUserId}
                            onChange={(id) => setAssigneeUserIdOverride(id)}
                            placeholder={t('parcelSheet.operatorPlaceholder')}
                            matchTriggerWidth
                        />
                    </FormField>

                    <FormField label={t('parcelSheet.technique')} hint={t('parcelSheet.techniqueHint')}>
                        <Combobox
                            options={techniqueOptions}
                            selected={techniqueOptions.find((o) => o.value === techniqueKey) ?? null}
                            setSelected={(o) => setTechniqueKey(o?.value ?? '')}
                            placeholder={t('parcelSheet.techniquePlaceholder')}
                            matchTriggerWidth
                        />
                    </FormField>
                    {techniqueKey === 'other' && (
                        <FormField label={t('parcelSheet.techniqueOtherLabel')}>
                            <Input
                                value={techniqueOther}
                                onChange={(e) => setTechniqueOther(e.target.value)}
                                placeholder={t('parcelSheet.techniqueOtherPlaceholder')}
                                id="parcel-sheet-technique-other"
                            />
                        </FormField>
                    )}

                    <FormField label={t('parcelSheet.note')}>
                        <Input
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder={t('parcelSheet.notePlaceholder')}
                            id="parcel-sheet-note"
                        />
                    </FormField>
                </div>
                )}

            </Sheet.Body>
            {parcel && (
                <Sheet.Actions align="between">
                    <Sheet.Close asChild>
                        <Button variant="secondary" size="lg">{tc('close')}</Button>
                    </Sheet.Close>
                    {/*
                      * The entry point to the parcel archive. The sheet is where
                      * a farmer already taps a parcel, and the archive is three
                      * chronological lists — too much for a sheet on a phone, so
                      * it lives on its own page and is reached from here. A page
                      * with no link into it is not a feature.
                      */}
                    <Link
                        href={`/t/${tenantSlug}/parcels/${parcel.id}`}
                        className={buttonVariants({ variant: 'secondary', size: 'lg' })}
                    >
                        {t('parcelSheet.viewHistory')}
                    </Link>
                    <Button
                        variant="primary"
                        size="lg"
                        data-testid="parcel-sheet-start-operation"
                        loading={submitting}
                        disabled={!canSubmit}
                        onClick={() => void doSubmit()}
                    >
                        {t('parcelSheet.createOperation')}
                    </Button>
                </Sheet.Actions>
            )}
        </Sheet>
    );
}

export default ParcelDetailSheet;
