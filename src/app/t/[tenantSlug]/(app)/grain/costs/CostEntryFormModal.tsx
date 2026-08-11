'use client';

/**
 * Create / edit a cost entry (enterprise-grain, GRAIN module).
 *
 * Dual-purpose modal mounted inside the Costs list:
 *   - no `record` prop  → POST  /grain/costs        (create)
 *   - `record` provided → PATCH /grain/costs/{id}   (edit)
 *
 * ── Why attribution is a TYPE selector plus one picker ──────────────
 *
 * A cost entry may link to AT MOST ONE of planting / season / location /
 * parcel / lease — a row claiming two homes is rendered on two domain
 * pages and summed twice by anything grouping per domain. The usecase
 * enforces that (`assertSingleDomainLink`), but a form with five
 * independent pickers invites the farmer to fill in two and then rejects
 * them, which is a worse experience than not offering it. Choosing the
 * KIND first makes one-link-only structural here rather than a 400.
 *
 * `Lease` appears only for a RENT entry, matching the narrower half of
 * the same rule: a diesel invoice filed against a lease would surface on
 * the rent page, where it reads as rent.
 *
 * `description` is NOT broadcast on the list (commercial free text,
 * encrypted at rest) — it is fetched on demand for the record being
 * edited, same shape as `PayrollFormModal`.
 */

import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, type Dispatch, type SetStateAction } from 'react';
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
import { currencyOptions } from '@/lib/grain/currencies';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { COST_CATEGORY_VALUES } from './filter-defs';
import type { CostRow } from './CostsClient';

interface PlantingOption {
    id: string;
    successionNumber: number;
    variety?: { id: string; name: string } | null;
    location?: { id: string; name: string } | null;
    cropPlan?: { id: string; name: string } | null;
    sowDate?: string | null;
}
interface NamedOption {
    id: string;
    name: string;
}
interface LeaseOption {
    id: string;
    parcel?: { id: string; name: string } | null;
    landlordName?: string | null;
}

/** Mirrors the server bound in grain.schemas.ts (`Decimal(14, 2)`), so the
 *  form refuses what the API would refuse instead of letting a 400 be the
 *  first feedback. */
const MAX_AMOUNT = 999_999_999_999;

/** The attribution kinds, mapped to their CostEntry column. */
const LINK_KINDS = ['none', 'planting', 'season', 'location', 'parcel', 'lease'] as const;
type LinkKind = (typeof LINK_KINDS)[number];

const LINK_COLUMN: Record<Exclude<LinkKind, 'none'>, string> = {
    planting: 'plantingId',
    season: 'seasonId',
    location: 'locationId',
    parcel: 'parcelId',
    lease: 'leaseId',
};

function isoToDate(v: string | null | undefined): Date | null {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** Which kind a persisted row already uses, for the edit case. */
function linkKindOf(record: CostRow | null | undefined): LinkKind {
    if (!record) return 'none';
    if (record.plantingId) return 'planting';
    if (record.seasonId) return 'season';
    if (record.locationId) return 'location';
    if (record.parcelId) return 'parcel';
    if (record.leaseId) return 'lease';
    return 'none';
}

function linkIdOf(record: CostRow | null | undefined): string {
    if (!record) return '';
    return (
        record.plantingId ??
        record.seasonId ??
        record.locationId ??
        record.parcelId ??
        record.leaseId ??
        ''
    );
}

type FormValues = {
    category: string;
    amount: string;
    currency: string;
    incurredOn: Date | null;
    supplier?: string;
    description?: string;
    linkKind: LinkKind;
    linkId?: string;
};

const DEFAULT_VALUES: FormValues = {
    category: '',
    amount: '',
    currency: '',
    incurredOn: null,
    supplier: '',
    description: '',
    linkKind: 'none',
    linkId: '',
};

export interface CostEntryFormModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    tenantSlug: string;
    /** When set, the modal edits this record (PATCH); else it creates. */
    record?: CostRow | null;
    onSaved?: () => void;
}

export function CostEntryFormModal({
    open,
    setOpen,
    tenantSlug,
    record,
    onSaved,
}: CostEntryFormModalProps) {
    const t = useTranslations('grain.costs.form');
    const tEnums = useTranslations('grainEnums');
    const apiUrl = useTenantApiUrl();
    const queryClient = useQueryClient();
    const isEdit = Boolean(record);

    // Built here rather than at module scope so the messages are localised.
    const formSchema = useMemo(
        () =>
            z.object({
                category: z.string().min(1, t('errRequired')),
                amount: z
                    .string()
                    .min(1, t('errRequired'))
                    .refine((v) => !Number.isNaN(Number(v)), t('errNotANumber'))
                    .refine((v) => Number.isNaN(Number(v)) || Number(v) > 0, t('errNotPositive'))
                    .refine(
                        (v) => Number.isNaN(Number(v)) || Number(v) <= MAX_AMOUNT,
                        t('errTooLarge'),
                    ),
                currency: z.string().min(1, t('errRequired')).max(8),
                incurredOn: z
                    .date()
                    .nullable()
                    .refine((d): d is Date => d != null, t('errRequired')),
                supplier: z.string().optional(),
                description: z.string().optional(),
                linkKind: z.enum(LINK_KINDS),
                linkId: z.string().optional(),
            }),
        [t],
    );

    const {
        register,
        handleSubmit,
        control,
        reset,
        setError: setFormError,
        setFocus,
        getValues,
        setValue,
        formState: { errors, isSubmitting },
    } = useForm<FormValues>({
        resolver: zodResolver(formSchema),
        defaultValues: DEFAULT_VALUES,
        mode: 'onTouched',
    });

    const watchedCategory = useWatch({ control, name: 'category' });
    const watchedLinkKind = useWatch({ control, name: 'linkKind' });
    const watchedCurrency = useWatch({ control, name: 'currency' });

    // Option sources — fetched lazily, and only the one the chosen kind
    // needs. Loading five pickers to show one is five requests a farmer on
    // rural LTE pays for and never sees.
    const plantingsQuery = useQuery<PlantingOption[]>({
        queryKey: ['grain', tenantSlug, 'plantings'],
        queryFn: async () => {
            const res = await fetch(apiUrl('/planning/plantings'));
            if (!res.ok) throw new Error('Failed to load plantings');
            return res.json();
        },
        enabled: open && watchedLinkKind === 'planting',
        staleTime: 60_000,
    });
    const seasonsQuery = useQuery<NamedOption[]>({
        queryKey: ['grain', tenantSlug, 'seasons'],
        queryFn: async () => {
            const res = await fetch(apiUrl('/planning/seasons'));
            if (!res.ok) throw new Error('Failed to load seasons');
            return res.json();
        },
        enabled: open && watchedLinkKind === 'season',
        staleTime: 60_000,
    });
    const locationsQuery = useQuery<NamedOption[]>({
        queryKey: ['grain', tenantSlug, 'locations'],
        queryFn: async () => {
            const res = await fetch(apiUrl('/locations'));
            if (!res.ok) throw new Error('Failed to load locations');
            const data = await res.json();
            return Array.isArray(data) ? data : (data.rows ?? []);
        },
        enabled: open && (watchedLinkKind === 'location' || watchedLinkKind === 'parcel'),
        staleTime: 60_000,
    });
    const leasesQuery = useQuery<LeaseOption[]>({
        queryKey: ['grain', tenantSlug, 'leases'],
        queryFn: async () => {
            const res = await fetch(apiUrl('/leases'));
            if (!res.ok) throw new Error('Failed to load leases');
            const data = await res.json();
            return Array.isArray(data) ? data : (data.rows ?? []);
        },
        enabled: open && watchedLinkKind === 'lease',
        staleTime: 60_000,
    });
    // `description` is not on the list row — commercial free text,
    // encrypted at rest. Fetch it for the one record being edited.
    const detailQuery = useQuery<{ description?: string | null }>({
        queryKey: ['grain', tenantSlug, 'cost-entry', record?.id],
        queryFn: async () => {
            const res = await fetch(apiUrl(`/grain/costs/${record!.id}`));
            if (!res.ok) throw new Error('Failed to load cost entry');
            return res.json();
        },
        enabled: open && Boolean(record?.id),
        staleTime: 0,
    });

    const categoryOptions: ComboboxOption[] = useMemo(
        () =>
            COST_CATEGORY_VALUES.map((value) => ({
                value,
                label: tEnums(`costCategory.${value}`),
            })),
        [tEnums],
    );

    // `lease` is offered ONLY on a RENT entry — the same rule the usecase
    // enforces, applied where the farmer can still change their mind.
    const linkKindOptions: ComboboxOption[] = useMemo(
        () =>
            LINK_KINDS.filter((k) => k !== 'lease' || watchedCategory === 'RENT').map((k) => ({
                value: k,
                label: t(`linkKind.${k}`),
            })),
        [t, watchedCategory],
    );

    const linkOptions: ComboboxOption[] = useMemo(() => {
        switch (watchedLinkKind) {
            case 'planting':
                return (plantingsQuery.data ?? []).map((p) => ({
                    value: p.id,
                    label: [
                        t('successionLabel', { n: p.successionNumber }),
                        p.variety?.name,
                        p.location?.name,
                        p.sowDate ? formatDate(p.sowDate) : null,
                    ]
                        .filter(Boolean)
                        .join(' · '),
                }));
            case 'season':
                return (seasonsQuery.data ?? []).map((s) => ({ value: s.id, label: s.name }));
            case 'location':
                return (locationsQuery.data ?? []).map((l) => ({ value: l.id, label: l.name }));
            case 'parcel':
                return (locationsQuery.data ?? []).map((l) => ({ value: l.id, label: l.name }));
            case 'lease':
                return (leasesQuery.data ?? []).map((l) => ({
                    value: l.id,
                    label: [l.parcel?.name, l.landlordName].filter(Boolean).join(' · ') || l.id,
                }));
            default:
                return [];
        }
    }, [watchedLinkKind, plantingsQuery.data, seasonsQuery.data, locationsQuery.data, leasesQuery.data, t]);

    const currencyChoices = useMemo(
        () => currencyOptions(watchedCurrency ?? record?.currency),
        [watchedCurrency, record],
    );

    useEffect(() => {
        if (!open) return;
        if (record) {
            reset({
                category: record.category,
                amount: String(record.amount),
                currency: record.currency ?? '',
                incurredOn: isoToDate(record.incurredOn),
                supplier: record.supplier ?? '',
                linkKind: linkKindOf(record),
                linkId: linkIdOf(record),
                // Filled in by the effect below once the detail read lands.
                description: '',
            });
        } else {
            reset(DEFAULT_VALUES);
        }
        const focusTimer = setTimeout(() => setFocus('amount'), 60);
        return () => clearTimeout(focusTimer);
    }, [open, record, reset, setFocus]);

    // Seed the description when the detail read lands. Guarded on the field
    // still being untouched so a slow response cannot overwrite typing.
    useEffect(() => {
        if (!open || !record?.id) return;
        const fetched = detailQuery.data?.description;
        if (fetched == null) return;
        if ((getValues('description') ?? '') !== '') return;
        setValue('description', fetched);
    }, [open, record?.id, detailQuery.data, getValues, setValue]);

    // Changing the KIND clears the id: an id from the previous kind would
    // be submitted against the new column and rejected as a foreign key
    // from another table.
    useEffect(() => {
        if (!open) return;
        if (linkKindOf(record) === watchedLinkKind) return;
        setValue('linkId', '');
    }, [watchedLinkKind, open, record, setValue]);

    // Leaving RENT with a lease link selected would submit a leaseId on a
    // non-RENT entry, which the usecase rejects. Drop back to none.
    useEffect(() => {
        if (!open) return;
        if (watchedLinkKind === 'lease' && watchedCategory !== 'RENT') {
            setValue('linkKind', 'none');
            setValue('linkId', '');
        }
    }, [watchedCategory, watchedLinkKind, open, setValue]);

    const onSubmit = async (values: FormValues) => {
        try {
            const links: Record<string, string | null> = {
                plantingId: null,
                seasonId: null,
                locationId: null,
                parcelId: null,
                leaseId: null,
            };
            if (values.linkKind !== 'none' && values.linkId) {
                links[LINK_COLUMN[values.linkKind]] = values.linkId;
            }

            const body = {
                category: values.category,
                amount: Number(values.amount),
                currency: values.currency.trim().toUpperCase(),
                incurredOn: values.incurredOn ? values.incurredOn.toISOString() : null,
                supplier: values.supplier?.trim() || null,
                description: values.description?.trim() || null,
                ...links,
            };
            const res = await fetch(
                isEdit
                    ? apiUrl(`/grain/costs/${record!.id}`)
                    : apiUrl('/grain/costs'),
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
                        : data.message || `Failed to ${isEdit ? 'update' : 'create'} cost entry`;
                throw new Error(msg);
            }
            queryClient.invalidateQueries({ queryKey: ['grain-costs', tenantSlug] });
            setOpen(false);
            onSaved?.();
        } catch (err) {
            setFormError('root.api', {
                type: 'api',
                message:
                    err instanceof Error
                        ? err.message
                        : `Failed to ${isEdit ? 'update' : 'create'} cost entry`,
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
                            id="cost-form-error"
                            role="alert"
                        >
                            {apiError}
                        </div>
                    )}

                    <div className="space-y-default">
                        <FormField label={t('category')} error={errors.category?.message}>
                            <Controller
                                control={control}
                                name="category"
                                render={({ field }) => (
                                    <Combobox
                                        id="cost-category-input"
                                        options={categoryOptions}
                                        selected={categoryOptions.find((o) => o.value === field.value) ?? null}
                                        setSelected={(o) => field.onChange(o?.value ?? '')}
                                        placeholder={t('categoryPlaceholder')}
                                    />
                                )}
                            />
                        </FormField>

                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <FormField label={t('amount')} error={errors.amount?.message}>
                                <Input
                                    id="cost-amount-input"
                                    inputMode="decimal"
                                    placeholder={t('amountPlaceholder')}
                                    autoComplete="off"
                                    {...register('amount')}
                                />
                            </FormField>
                            <FormField label={t('currency')} error={errors.currency?.message}>
                                <Controller
                                    control={control}
                                    name="currency"
                                    render={({ field }) => (
                                        <Combobox
                                            id="cost-currency-input"
                                            options={currencyChoices}
                                            selected={currencyChoices.find((o) => o.value === field.value) ?? null}
                                            setSelected={(o) => field.onChange(o?.value ?? '')}
                                            placeholder={t('currencyPlaceholder')}
                                        />
                                    )}
                                />
                            </FormField>
                        </div>

                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <FormField label={t('incurredOn')} error={errors.incurredOn?.message}>
                                <Controller
                                    control={control}
                                    name="incurredOn"
                                    render={({ field }) => (
                                        <DatePicker
                                            id="cost-incurred-input"
                                            value={field.value}
                                            onChange={field.onChange}
                                        />
                                    )}
                                />
                            </FormField>
                            <FormField label={t('supplier')} error={errors.supplier?.message}>
                                <Input
                                    id="cost-supplier-input"
                                    placeholder={t('supplierPlaceholder')}
                                    autoComplete="off"
                                    {...register('supplier')}
                                />
                            </FormField>
                        </div>

                        {/* Attribution — the KIND first, so a cost can never
                            claim two homes. */}
                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <FormField label={t('linkKindLabel')} hint={t('linkKindHint')}>
                                <Controller
                                    control={control}
                                    name="linkKind"
                                    render={({ field }) => (
                                        <Combobox
                                            id="cost-link-kind-input"
                                            options={linkKindOptions}
                                            selected={linkKindOptions.find((o) => o.value === field.value) ?? null}
                                            setSelected={(o) => field.onChange(o?.value ?? '')}
                                        />
                                    )}
                                />
                            </FormField>
                            {watchedLinkKind !== 'none' && (
                                <FormField label={t('linkTargetLabel')}>
                                    <Controller
                                        control={control}
                                        name="linkId"
                                        render={({ field }) => (
                                            <Combobox
                                                id="cost-link-id-input"
                                                options={linkOptions}
                                                selected={linkOptions.find((o) => o.value === (field.value ?? '')) ?? null}
                                                setSelected={(o) => field.onChange(o?.value ?? '')}
                                                placeholder={t('linkTargetPlaceholder')}
                                            />
                                        )}
                                    />
                                </FormField>
                            )}
                        </div>

                        <FormField label={t('description')} error={errors.description?.message}>
                            <Textarea
                                id="cost-description-input"
                                rows={3}
                                placeholder={t('descriptionPlaceholder')}
                                {...register('description')}
                            />
                        </FormField>
                    </div>
                </Modal.Body>
                <Modal.Footer>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={() => setOpen(false)}
                        disabled={isSubmitting}
                    >
                        {t('cancel')}
                    </Button>
                    <Button type="submit" variant="primary" loading={isSubmitting}>
                        {isEdit ? t('saveCost') : t('createCost')}
                    </Button>
                </Modal.Footer>
            </Modal.Form>
        </Modal>
    );
}
