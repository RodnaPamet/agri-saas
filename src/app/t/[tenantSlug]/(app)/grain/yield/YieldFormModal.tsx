'use client';

/**
 * Create / edit a grain yield record (actual harvest production).
 *
 * Dual-purpose modal mounted inside the Yield list:
 *   - no `record` prop  → POST  /grain/yield-records        (create)
 *   - `record` provided → PATCH /grain/yield-records/{id}   (edit)
 *
 * Captures the gross tonnes realised against a planting / field / season
 * with the moisture basis + area (the server derives t/ha). All three FK
 * relations are optional/clearable comboboxes, fetched lazily on open
 * (plantings + locations + seasons). Numeric magnitudes are captured as
 * text and coerced to `number | null` on the wire.
 */

import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
    useEffect,
    useMemo,
    type Dispatch,
    type SetStateAction,
} from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { formatDate } from '@/lib/format-date';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import type { YieldRow } from './YieldClient';

interface PlantingOption {
    id: string;
    successionNumber: number;
    variety?: { id: string; name: string } | null;
    location?: { id: string; name: string } | null;
    cropPlan?: { id: string; name: string } | null;
    sowDate?: string | null;
    harvestStartDate?: string | null;
}
interface LocationOption {
    id: string;
    name: string;
}
interface SeasonOption {
    id: string;
    name: string;
}

/**
 * A numeric text field, built per-render so its messages are translated —
 * the schema used to carry the English literal 'Must be zero or positive',
 * which reached a Bulgarian farmer untranslated.
 *
 * Three distinct outcomes, because they need three distinct fixes:
 * unparseable input ("abc"), a negative number, and a value beyond what the
 * column holds. Collapsing them into one message tells the user something
 * is wrong without telling them what.
 */
function makeNumericText(
    messages: { notANumber: string; negative: string; tooLarge: string },
    max: number,
) {
    return z
        .string()
        .optional()
        .refine((v) => v == null || v.trim() === '' || !Number.isNaN(Number(v)), messages.notANumber)
        .refine((v) => v == null || v.trim() === '' || Number.isNaN(Number(v)) || Number(v) >= 0, messages.negative)
        .refine((v) => v == null || v.trim() === '' || Number.isNaN(Number(v)) || Number(v) <= max, messages.tooLarge);
}

/** Mirrors the server bounds in grain.schemas.ts, so the form refuses what
 *  the API would refuse instead of letting a 400 be the first feedback. */
const MAX_TONNES = 99_999_999_999;
const MAX_AREA_HA = 99_999_999;
const MAX_MOISTURE_PCT = 40;

type FormValues = {
    commodity?: string;
    harvestedAt: Date | null;
    grossTonnes?: string;
    moisturePct?: string;
    areaHa?: string;
    plantingId?: string;
    locationId?: string;
    seasonId?: string;
    valuationNotes?: string;
};

const DEFAULT_VALUES: FormValues = {
    commodity: '',
    harvestedAt: null,
    grossTonnes: '',
    moisturePct: '',
    areaHa: '',
    plantingId: '',
    locationId: '',
    seasonId: '',
    valuationNotes: '',
};

function textToNum(v: string | undefined): number | null {
    if (v == null || v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}
function numToText(v: number | null | undefined): string {
    return v == null ? '' : String(v);
}
function isoToDate(v: string | null | undefined): Date | null {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}

export interface YieldFormModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    tenantSlug: string;
    /** When set, the modal edits this record (PATCH); else it creates. */
    record?: YieldRow | null;
    onSaved?: () => void;
}

export function YieldFormModal({
    open,
    setOpen,
    tenantSlug,
    record,
    onSaved,
}: YieldFormModalProps) {
    const t = useTranslations('grain.yield.form');
    const apiUrl = useTenantApiUrl();
    const queryClient = useQueryClient();
    const isEdit = Boolean(record);

    // Built here rather than at module scope so the messages are localised.
    const formSchema = useMemo(
        () =>
            z.object({
                commodity: z.string().optional(),
                harvestedAt: z.date().nullable(),
                grossTonnes: makeNumericText(
                    {
                        notANumber: t('errNotANumber'),
                        negative: t('errNegative'),
                        tooLarge: t('errTooLarge'),
                    },
                    MAX_TONNES,
                ),
                moisturePct: makeNumericText(
                    {
                        notANumber: t('errNotANumber'),
                        negative: t('errNegative'),
                        tooLarge: t('errMoistureRange', { max: MAX_MOISTURE_PCT }),
                    },
                    MAX_MOISTURE_PCT,
                ),
                areaHa: makeNumericText(
                    {
                        notANumber: t('errNotANumber'),
                        negative: t('errNegative'),
                        tooLarge: t('errTooLarge'),
                    },
                    MAX_AREA_HA,
                ),
                plantingId: z.string().optional(),
                locationId: z.string().optional(),
                seasonId: z.string().optional(),
                valuationNotes: z.string().optional(),
            }),
        [t],
    );

    // FK option sources — fetched lazily when the modal opens.
    const plantingsQuery = useQuery<PlantingOption[]>({
        queryKey: ['grain', tenantSlug, 'plantings'],
        queryFn: async () => {
            const res = await fetch(apiUrl('/planning/plantings'));
            if (!res.ok) throw new Error('Failed to load plantings');
            return res.json();
        },
        enabled: open,
        staleTime: 60_000,
    });
    const locationsQuery = useQuery<LocationOption[]>({
        queryKey: ['grain', tenantSlug, 'locations', 'FIELD'],
        queryFn: async () => {
            // kind=FIELD — a Location is a field OR a store depending on
            // kind, and without asking, grain bins and sheds appeared in a
            // "Field" picker and then flowed into the Field facet and the
            // per-field recap as if crops had been grown in them.
            const res = await fetch(apiUrl('/locations?kind=FIELD'));
            if (!res.ok) throw new Error('Failed to load locations');
            return res.json();
        },
        enabled: open,
        staleTime: 60_000,
    });
    // valuationNotes is no longer broadcast in the list — it is commercial
    // commentary, encrypted at rest, and readers who cannot open this form
    // were receiving it decrypted in the page payload. Fetch it for the one
    // record being edited, and only when the form is actually open.
    const detailQuery = useQuery<{ valuationNotes?: string | null }>({
        queryKey: ['grain', tenantSlug, 'yield-record', record?.id],
        queryFn: async () => {
            const res = await fetch(apiUrl(`/grain/yield-records/${record!.id}`));
            if (!res.ok) throw new Error('Failed to load yield record');
            return res.json();
        },
        enabled: open && Boolean(record?.id),
        staleTime: 0,
    });

    const seasonsQuery = useQuery<SeasonOption[]>({
        queryKey: ['grain', tenantSlug, 'seasons'],
        queryFn: async () => {
            const res = await fetch(apiUrl('/planning/seasons'));
            if (!res.ok) throw new Error('Failed to load seasons');
            return res.json();
        },
        enabled: open,
        staleTime: 60_000,
    });

    const {
        register,
        handleSubmit,
        control,
        reset,
        setError: setFormError,
        setFocus,
        setValue,
        getValues,
        formState: { errors, isSubmitting },
    } = useForm<FormValues>({
        resolver: zodResolver(formSchema),
        defaultValues: DEFAULT_VALUES,
        mode: 'onTouched',
    });

    // `useWatch` rather than `watch()`: watch() returns a fresh function on
    // every render, so its result is not safe in a dependency array — and
    // the planting list below is derived from this value.
    const watchedLocationId = useWatch({ control, name: 'locationId' });
    const watchedPlantingId = useWatch({ control, name: 'plantingId' });

    // Commodity is free text, which fragments fast ("Wheat" / "wheat" /
    // "Winter wheat" are three commodities to a GROUP BY). The planting
    // already names its variety, so selecting one fills the field — the
    // farmer can still overwrite it.
    useEffect(() => {
        if (!open || !watchedPlantingId) return;
        const variety = (plantingsQuery.data ?? []).find((p) => p.id === watchedPlantingId)?.variety?.name;
        if (!variety) return;
        const current = getValues('commodity');
        if (current && current.trim() !== '') return;
        setValue('commodity', variety, { shouldDirty: true });
    }, [open, watchedPlantingId, plantingsQuery.data, getValues, setValue]);

    // "No X" sentinels make the optional relations clearable (the Combobox
    // has no built-in clear affordance).
    // A planting label has to be unique to be pickable. "Succession 1 ·
    // Winter Wheat" recurs in every crop plan and on every field, so the
    // list was a column of identical rows; field + plan + sow date are what
    // actually distinguish them to a farmer.
    const plantingOptions: ComboboxOption[] = [
        { value: '', label: t('noPlanting') },
        ...(plantingsQuery.data ?? [])
            // Scoped to the chosen field when there is one: picking a field
            // first is the common order, and it cuts the list to the
            // plantings that could plausibly have produced this harvest.
            // Plantings with no field stay visible — hiding them would make
            // an unassigned planting unreachable.
            .filter((p) => !watchedLocationId || !p.location?.id || p.location.id === watchedLocationId)
            .map((p) => {
                const parts = [
                    t('successionLabel', { n: p.successionNumber }),
                    p.variety?.name,
                    p.location?.name,
                    p.cropPlan?.name,
                    p.sowDate ? formatDate(p.sowDate) : null,
                ].filter(Boolean);
                return { value: p.id, label: parts.join(' · ') };
            }),
    ];
    const locationOptions: ComboboxOption[] = [
        { value: '', label: t('noField') },
        ...(locationsQuery.data ?? []).map((l) => ({ value: l.id, label: l.name })),
    ];
    // Planting + Season both come from PLANNING-gated endpoints. On a
    // GRAIN-only tenant those requests 403, and the modal used to render the
    // "No planting" sentinel exactly as if the farm simply had none — so the
    // fix (turn on Planning, or record the harvest without a planting) was
    // invisible. Surface the failure instead of impersonating an empty list.
    const planningUnavailable = plantingsQuery.isError || seasonsQuery.isError;

    const seasonOptions: ComboboxOption[] = [
        { value: '', label: t('noSeason') },
        ...(seasonsQuery.data ?? []).map((s) => ({ value: s.id, label: s.name })),
    ];


    useEffect(() => {
        if (!open) return;
        if (record) {
            reset({
                commodity: record.commodity ?? '',
                harvestedAt: isoToDate(record.harvestedAt),
                grossTonnes: numToText(record.grossTonnes),
                moisturePct: numToText(record.moisturePct),
                areaHa: numToText(record.areaHa),
                plantingId: record.plantingId ?? '',
                locationId: record.locationId ?? '',
                seasonId: record.seasonId ?? '',
                // Filled in by the effect below once the detail read
                // returns — the list row no longer carries it.
                valuationNotes: '',
            });
        } else {
            reset(DEFAULT_VALUES);
        }
        const t = setTimeout(() => setFocus('commodity'), 60);
        return () => clearTimeout(t);
    }, [open, record, reset, setFocus]);

    // Seed the notes when the detail read lands. Guarded on the field
    // still being untouched so a slow response cannot overwrite typing.
    useEffect(() => {
        if (!open || !record?.id) return;
        const fetched = detailQuery.data?.valuationNotes;
        if (fetched == null) return;
        if ((getValues('valuationNotes') ?? '') !== '') return;
        setValue('valuationNotes', fetched);
    }, [open, record?.id, detailQuery.data, getValues, setValue]);

    const onSubmit = async (values: FormValues) => {
        try {
            const body = {
                commodity: values.commodity?.trim() || null,
                harvestedAt: values.harvestedAt
                    ? values.harvestedAt.toISOString()
                    : null,
                grossTonnes: textToNum(values.grossTonnes),
                moisturePct: textToNum(values.moisturePct),
                areaHa: textToNum(values.areaHa),
                plantingId: values.plantingId || null,
                locationId: values.locationId || null,
                seasonId: values.seasonId || null,
                valuationNotes: values.valuationNotes?.trim() || null,
            };
            const res = await fetch(
                isEdit
                    ? apiUrl(`/grain/yield-records/${record!.id}`)
                    : apiUrl('/grain/yield-records'),
                {
                    method: isEdit ? 'PATCH' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                },
            );
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                const msg =
                    typeof data.error === 'string'
                        ? data.error
                        : data.message ||
                          `Failed to ${isEdit ? 'update' : 'create'} yield record`;
                throw new Error(msg);
            }
            queryClient.invalidateQueries({
                queryKey: ['grain-yield', tenantSlug],
            });
            setOpen(false);
            onSaved?.();
        } catch (err) {
            setFormError('root.api', {
                type: 'api',
                message:
                    err instanceof Error
                        ? err.message
                        : `Failed to ${isEdit ? 'update' : 'create'} yield record`,
            });
        }
    };

    const apiError = errors.root?.api?.message;
    const heading = isEdit ? t('editTitle') : t('newTitle');
    const description = isEdit ? t('editDescription') : t('newDescription');

    return (
        <Modal
            showModal={open}
            setShowModal={setOpen}
            size="lg"
            title={heading}
            description={description}
            preventDefaultClose={isSubmitting}
        >
            <Modal.Header title={heading} description={description} />
            <Modal.Form onSubmit={handleSubmit(onSubmit)}>
                <Modal.Body>
                    {apiError && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="yield-form-error"
                            role="alert"
                        >
                            {apiError}
                        </div>
                    )}

                    <div className="space-y-default">
                        <FormField
                            label={t('commodity')}
                            error={errors.commodity?.message}
                        >
                            <Input
                                id="yield-commodity-input"
                                type="text"
                                placeholder={t('commodityPlaceholder')}
                                autoComplete="off"
                                {...register('commodity')}
                            />
                        </FormField>

                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <FormField
                                label={t('harvestedAt')}
                                error={errors.harvestedAt?.message}
                            >
                                <Controller
                                    control={control}
                                    name="harvestedAt"
                                    render={({ field }) => (
                                        <DatePicker
                                            id="yield-harvested-at-input"
                                            value={field.value}
                                            onChange={(d) => field.onChange(d)}
                                            placeholder={t('datePlaceholder')}
                                        />
                                    )}
                                />
                            </FormField>
                            <FormField
                                label={t('grossTonnes')}
                                error={errors.grossTonnes?.message}
                            >
                                <Input
                                    id="yield-gross-tonnes-input"
                                    inputMode="decimal"
                                    placeholder={t('grossPlaceholder')}
                                    autoComplete="off"
                                    {...register('grossTonnes')}
                                />
                            </FormField>
                        </div>

                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <FormField
                                label={t('moisture')}
                                error={errors.moisturePct?.message}
                            >
                                <Input
                                    id="yield-moisture-input"
                                    inputMode="decimal"
                                    placeholder={t('moisturePlaceholder')}
                                    autoComplete="off"
                                    {...register('moisturePct')}
                                />
                            </FormField>
                            <FormField
                                label={t('area')}
                                error={errors.areaHa?.message}
                            >
                                <Input
                                    id="yield-area-input"
                                    inputMode="decimal"
                                    placeholder={t('areaPlaceholder')}
                                    autoComplete="off"
                                    {...register('areaHa')}
                                />
                            </FormField>
                        </div>

                        <FormField
                            label={t('planting')}
                            hint={t('plantingHint')}
                            // An empty picker on a GRAIN-only tenant is not
                            // "no plantings" — it is the Planning module
                            // being off. Say which, so the reader knows
                            // whether to add a planting or enable a module.
                            description={planningUnavailable ? t('planningUnavailable') : undefined}
                            error={errors.plantingId?.message}
                        >
                            <Controller
                                control={control}
                                name="plantingId"
                                render={({ field }) => (
                                    <Combobox
                                        id="yield-planting-input"
                                        name="plantingId"
                                        options={plantingOptions}
                                        selected={
                                            plantingOptions.find(
                                                (o) => o.value === field.value,
                                            ) ?? null
                                        }
                                        setSelected={(o) =>
                                            field.onChange(o?.value ?? '')
                                        }
                                        placeholder={t('plantingPlaceholder')}
                                        matchTriggerWidth
                                        buttonProps={{ className: 'w-full' }}
                                        caret
                                    />
                                )}
                            />
                        </FormField>

                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <FormField
                                label={t('field')}
                                error={errors.locationId?.message}
                            >
                                <Controller
                                    control={control}
                                    name="locationId"
                                    render={({ field }) => (
                                        <Combobox
                                            id="yield-location-input"
                                            name="locationId"
                                            options={locationOptions}
                                            selected={
                                                locationOptions.find(
                                                    (o) => o.value === field.value,
                                                ) ?? null
                                            }
                                            setSelected={(o) =>
                                                field.onChange(o?.value ?? '')
                                            }
                                            placeholder={t('fieldPlaceholder')}
                                            matchTriggerWidth
                                            buttonProps={{ className: 'w-full' }}
                                            caret
                                        />
                                    )}
                                />
                            </FormField>
                            <FormField
                                label={t('season')}
                                error={errors.seasonId?.message}
                            >
                                <Controller
                                    control={control}
                                    name="seasonId"
                                    render={({ field }) => (
                                        <Combobox
                                            id="yield-season-input"
                                            name="seasonId"
                                            options={seasonOptions}
                                            selected={
                                                seasonOptions.find(
                                                    (o) => o.value === field.value,
                                                ) ?? null
                                            }
                                            setSelected={(o) =>
                                                field.onChange(o?.value ?? '')
                                            }
                                            placeholder={t('seasonPlaceholder')}
                                            matchTriggerWidth
                                            buttonProps={{ className: 'w-full' }}
                                            caret
                                        />
                                    )}
                                />
                            </FormField>
                        </div>

                        <FormField
                            label={t('valuationNotes')}
                            error={errors.valuationNotes?.message}
                        >
                            <Textarea
                                id="yield-valuation-notes-input"
                                rows={2}
                                placeholder={t('valuationPlaceholder')}
                                {...register('valuationNotes')}
                            />
                        </FormField>
                    </div>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        id="yield-cancel-btn"
                        onClick={() => {
                            if (!isSubmitting) setOpen(false);
                        }}
                        disabled={isSubmitting}
                    >
                        {t('cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        id="save-yield-btn"
                        loading={isSubmitting}
                    >
                        {isEdit ? t('saveYield') : t('createYield')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
