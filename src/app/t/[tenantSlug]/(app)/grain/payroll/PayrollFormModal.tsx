'use client';

/**
 * Create / edit a payroll / labour-cost expense (enterprise-grain, GRAIN
 * module).
 *
 * Dual-purpose modal mounted inside the Payroll list:
 *   - no `record` prop  → POST  /grain/payroll        (create)
 *   - `record` provided → PATCH /grain/payroll/{id}   (edit)
 *
 * Captures the amount + currency, the pay-period date, an optional
 * planting / season attribution, and free-text notes. `description` is NOT
 * broadcast on the list (commercial/personal free text, encrypted at
 * rest) — it is fetched on demand for the record being edited, same shape
 * as `YieldFormModal`'s `valuationNotes` fetch.
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
import { currencyOptions } from '@/lib/grain/currencies';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import type { PayrollRow } from './PayrollClient';

interface PlantingOption {
    id: string;
    successionNumber: number;
    variety?: { id: string; name: string } | null;
    location?: { id: string; name: string } | null;
    cropPlan?: { id: string; name: string } | null;
    sowDate?: string | null;
}
interface SeasonOption {
    id: string;
    name: string;
}

/** Mirrors the server bound in grain.schemas.ts (`MAX_PAYROLL_AMOUNT`,
 *  `Decimal(14, 2)`), so the form refuses what the API would refuse
 *  instead of letting a 400 be the first feedback. */
const MAX_AMOUNT = 999_999_999_999;

function isoToDate(v: string | null | undefined): Date | null {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}

type FormValues = {
    amount: string;
    currency: string;
    incurredOn: Date | null;
    description?: string;
    plantingId?: string;
    seasonId?: string;
};

const DEFAULT_VALUES: FormValues = {
    amount: '',
    currency: '',
    incurredOn: null,
    description: '',
    plantingId: '',
    seasonId: '',
};

export interface PayrollFormModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    tenantSlug: string;
    /** When set, the modal edits this record (PATCH); else it creates. */
    record?: PayrollRow | null;
    onSaved?: () => void;
}

export function PayrollFormModal({
    open,
    setOpen,
    tenantSlug,
    record,
    onSaved,
}: PayrollFormModalProps) {
    const t = useTranslations('payroll.form');
    const apiUrl = useTenantApiUrl();
    const queryClient = useQueryClient();
    const isEdit = Boolean(record);

    // Built here rather than at module scope so the messages are localised.
    const formSchema = useMemo(
        () =>
            z.object({
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
                description: z.string().optional(),
                plantingId: z.string().optional(),
                seasonId: z.string().optional(),
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
    // description is no longer broadcast in the list — commercial/personal
    // free text, encrypted at rest. Fetch it for the one record being
    // edited, and only when the form is actually open.
    const detailQuery = useQuery<{ description?: string | null }>({
        queryKey: ['grain', tenantSlug, 'payroll-expense', record?.id],
        queryFn: async () => {
            const res = await fetch(apiUrl(`/grain/payroll/${record!.id}`));
            if (!res.ok) throw new Error('Failed to load payroll expense');
            return res.json();
        },
        enabled: open && Boolean(record?.id),
        staleTime: 0,
    });

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

    // "No X" sentinels make the optional relations clearable (the Combobox
    // has no built-in clear affordance) — same shape as YieldFormModal.
    const plantingOptions: ComboboxOption[] = [
        { value: '', label: t('noPlanting') },
        ...(plantingsQuery.data ?? []).map((p) => {
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
    const seasonOptions: ComboboxOption[] = [
        { value: '', label: t('noSeason') },
        ...(seasonsQuery.data ?? []).map((s) => ({ value: s.id, label: s.name })),
    ];
    // Planting + Season both come from PLANNING-gated endpoints. On a
    // GRAIN-only tenant those requests 403, and an empty picker would look
    // exactly like "this farm has none" — say which, so the reader knows
    // whether to add a planting or enable a module.
    const planningUnavailable = plantingsQuery.isError || seasonsQuery.isError;

    // `useWatch` rather than `watch()`: watch() returns a fresh function on
    // every render, which is not safe in a dependency array.
    const watchedCurrency = useWatch({ control, name: 'currency' });
    const currencyChoices = useMemo(
        () => currencyOptions(watchedCurrency ?? record?.currency),
        [watchedCurrency, record],
    );

    useEffect(() => {
        if (!open) return;
        if (record) {
            reset({
                amount: String(record.amount),
                currency: record.currency ?? '',
                incurredOn: isoToDate(record.incurredOn),
                plantingId: record.plantingId ?? '',
                seasonId: record.seasonId ?? '',
                // Filled in by the effect below once the detail read
                // returns — the list row no longer carries it.
                description: '',
            });
        } else {
            reset(DEFAULT_VALUES);
        }
        const focusTimer = setTimeout(() => setFocus('amount'), 60);
        return () => clearTimeout(focusTimer);
    }, [open, record, reset, setFocus]);

    // Seed the description when the detail read lands. Guarded on the
    // field still being untouched so a slow response cannot overwrite
    // typing.
    useEffect(() => {
        if (!open || !record?.id) return;
        const fetched = detailQuery.data?.description;
        if (fetched == null) return;
        if ((getValues('description') ?? '') !== '') return;
        setValue('description', fetched);
    }, [open, record?.id, detailQuery.data, getValues, setValue]);

    const onSubmit = async (values: FormValues) => {
        try {
            const body = {
                amount: Number(values.amount),
                currency: values.currency.trim().toUpperCase(),
                incurredOn: values.incurredOn ? values.incurredOn.toISOString() : null,
                description: values.description?.trim() || null,
                plantingId: values.plantingId || null,
                seasonId: values.seasonId || null,
            };
            const res = await fetch(
                isEdit
                    ? apiUrl(`/grain/payroll/${record!.id}`)
                    : apiUrl('/grain/payroll'),
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
                          `Failed to ${isEdit ? 'update' : 'create'} payroll expense`;
                throw new Error(msg);
            }
            queryClient.invalidateQueries({
                queryKey: ['grain-payroll', tenantSlug],
            });
            setOpen(false);
            onSaved?.();
        } catch (err) {
            setFormError('root.api', {
                type: 'api',
                message:
                    err instanceof Error
                        ? err.message
                        : `Failed to ${isEdit ? 'update' : 'create'} payroll expense`,
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
                            id="payroll-form-error"
                            role="alert"
                        >
                            {apiError}
                        </div>
                    )}

                    <div className="space-y-default">
                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <FormField
                                label={t('amount')}
                                error={errors.amount?.message}
                            >
                                <Input
                                    id="payroll-amount-input"
                                    inputMode="decimal"
                                    placeholder={t('amountPlaceholder')}
                                    autoComplete="off"
                                    {...register('amount')}
                                />
                            </FormField>
                            <FormField
                                label={t('currency')}
                                error={errors.currency?.message}
                            >
                                <Controller
                                    control={control}
                                    name="currency"
                                    render={({ field }) => (
                                        <Combobox
                                            id="payroll-currency-input"
                                            name="currency"
                                            options={currencyChoices}
                                            selected={
                                                currencyChoices.find(
                                                    (o) => o.value === field.value,
                                                ) ?? null
                                            }
                                            setSelected={(o) =>
                                                field.onChange(o?.value ?? '')
                                            }
                                            placeholder={t('currencyPlaceholder')}
                                            matchTriggerWidth
                                            buttonProps={{ className: 'w-full' }}
                                            caret
                                        />
                                    )}
                                />
                            </FormField>
                        </div>

                        <FormField
                            label={t('incurredOn')}
                            error={errors.incurredOn?.message}
                        >
                            <Controller
                                control={control}
                                name="incurredOn"
                                render={({ field }) => (
                                    <DatePicker
                                        id="payroll-incurred-on-input"
                                        value={field.value}
                                        onChange={(d) => field.onChange(d)}
                                        placeholder={t('datePlaceholder')}
                                    />
                                )}
                            />
                        </FormField>

                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <FormField
                                label={t('planting')}
                                hint={t('plantingHint')}
                                // An empty picker on a GRAIN-only tenant is not
                                // "no plantings" — it is the Planning module
                                // being off.
                                description={planningUnavailable ? t('planningUnavailable') : undefined}
                                error={errors.plantingId?.message}
                            >
                                <Controller
                                    control={control}
                                    name="plantingId"
                                    render={({ field }) => (
                                        <Combobox
                                            id="payroll-planting-input"
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
                            <FormField
                                label={t('season')}
                                error={errors.seasonId?.message}
                            >
                                <Controller
                                    control={control}
                                    name="seasonId"
                                    render={({ field }) => (
                                        <Combobox
                                            id="payroll-season-input"
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
                            label={t('description')}
                            error={errors.description?.message}
                        >
                            <Textarea
                                id="payroll-description-input"
                                rows={2}
                                placeholder={t('descriptionPlaceholder')}
                                {...register('description')}
                            />
                        </FormField>
                    </div>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        id="payroll-cancel-btn"
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
                        id="save-payroll-btn"
                        loading={isSubmitting}
                    >
                        {isEdit ? t('savePayroll') : t('createPayroll')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
