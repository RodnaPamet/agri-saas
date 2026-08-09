'use client';

/**
 * Create / edit a grain contract.
 *
 * Modal-based form mounted inside the Contracts list so the table state,
 * filters, and scroll position survive opening the form. Dual-purpose:
 *   - no `contract` prop  → POST  /grain/contracts        (create)
 *   - `contract` provided → PATCH /grain/contracts/{id}   (edit)
 *
 * Form pattern (Epic 64-FORM, mirrors NewPracticeModal):
 *   - `useForm` + `zodResolver` for state + validation
 *   - `<FormField>` wraps each control
 *   - `register(...)` for plain inputs / textareas
 *   - `<Controller>` for the Combobox + DatePicker primitives
 *
 * Decimal magnitudes (volumeTonnes / pricePerTonne) are captured as text
 * inputs and coerced to `number | null` for the wire (the schema's
 * `NonNegativeNumber`). Season options are fetched from the PLANNING
 * seasons API (a grain tenant always also has PLANNING) — the select is
 * optional/clearable.
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
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { currencyOptions } from '@/lib/grain/currencies';
import {
    contractStatusOptions,
    contractTypeOptions,
} from './filter-defs';
import type { ContractDetail, ContractRow } from './ContractsClient';

interface SeasonOption {
    id: string;
    name: string;
}

/** The PLANNING module is not enabled for this tenant — distinct from
 *  "the seasons request failed" and from "there are no seasons yet". */
class PlanningUnavailableError extends Error {
    constructor() {
        super('PLANNING module unavailable');
        this.name = 'PlanningUnavailableError';
    }
}

// ─── Schema ──────────────────────────────────────────────────────────
//
// Client form contract. The server schema (`CreateContractSchema`) is the
// authority; this enforces the practical subset (counterparty required +
// non-negative numeric magnitudes). Numbers are typed as text and coerced
// on submit so an empty field maps to `null`, not `0`.

const numericText = z
    .string()
    .optional()
    .refine(
        (v) => v == null || v.trim() === '' || Number(v) >= 0,
        'Must be zero or positive',
    );

const formSchema = z.object({
    key: z.string().max(120).optional(),
    counterparty: z.string().min(1, 'Counterparty is required'),
    commodity: z.string().optional(),
    type: z.enum(['SALE', 'PURCHASE']),
    status: z.enum(['DRAFT', 'ACTIVE', 'DELIVERED', 'SETTLED', 'CANCELLED']),
    volumeTonnes: numericText,
    pricePerTonne: numericText,
    priceCurrency: z.string().max(8).optional(),
    deliveryStart: z.date().nullable(),
    deliveryEnd: z.date().nullable(),
    seasonId: z.string().optional(),
    terms: z.string().optional(),
    pricingNotes: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

/**
 * Pull the human message out of an API error body, appending field
 * details when the server sent them (a Zod issue list or the offending
 * unique-constraint columns).
 */
function resolveApiError(data: unknown, isEdit: boolean): string {
    const body = data as {
        error?: { message?: string; code?: string; details?: unknown };
    };
    const base =
        body?.error?.message ??
        `Failed to ${isEdit ? 'update' : 'create'} contract`;

    const details = body?.error?.details;
    if (Array.isArray(details) && details.length > 0) {
        const fields = details
            .map((d) => {
                const issue = d as { path?: unknown; message?: string };
                const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
                return path && issue.message ? `${path}: ${issue.message}` : issue.message;
            })
            .filter(Boolean);
        if (fields.length > 0) return `${base} (${fields.join('; ')})`;
    }
    return base;
}

const DEFAULT_VALUES: FormValues = {
    key: '',
    counterparty: '',
    commodity: '',
    type: 'SALE',
    status: 'DRAFT',
    volumeTonnes: '',
    pricePerTonne: '',
    priceCurrency: '',
    deliveryStart: null,
    deliveryEnd: null,
    seasonId: '',
    terms: '',
    pricingNotes: '',
};

/** Map a string|null decimal from the row into the form's text field. */
function decToText(v: string | null | undefined): string {
    return v == null ? '' : String(v);
}
/** Map a form text field back to `number | null` for the wire. */
function textToNum(v: string | undefined): number | null {
    if (v == null || v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}
/** Map an ISO string|null into a Date|null for DatePicker. */
function isoToDate(v: string | null | undefined): Date | null {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}

// ─── Component ───────────────────────────────────────────────────────

export interface ContractFormModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    tenantSlug: string;
    /** When set, the modal edits this contract (PATCH); else it creates. */
    contract?: ContractRow | null;
    /** Called after a successful create/edit so the page can refetch. */
    onSaved?: () => void;
}

export function ContractFormModal({
    open,
    setOpen,
    tenantSlug,
    contract,
    onSaved,
}: ContractFormModalProps) {
    const t = useTranslations('grain.contracts.form');
    // ENUM MEMBER labels come from the `ag` namespace — the SAME keys
    // `<AgStatusBadge>` renders in the table. Before this, the modal
    // built its dropdowns from hardcoded English literals, so a
    // Bulgarian user saw translated badges and chips and then an
    // English dropdown in the form that edits them.
    const tAg = useTranslations('ag');
    const tContracts = useTranslations('grain.contracts');
    const typeOptions: ComboboxOption[] = useMemo(() => contractTypeOptions(tAg), [tAg]);
    const statusOptions: ComboboxOption[] = useMemo(
        () => contractStatusOptions(tAg),
        [tAg],
    );
    const apiUrl = useTenantApiUrl();
    const queryClient = useQueryClient();
    const isEdit = Boolean(contract);

    // ── Full row on demand ──
    //
    // The LIST no longer carries `terms` / `pricingNotes` — they are
    // Epic-B encrypted columns that used to ride along decrypted for up
    // to 500 rows into every viewer's cache. This is the fetch that
    // replaces that: ONE contract, only when someone actually opens it.
    // It also gives the previously-dead GET /grain/contracts/[id] route
    // its first caller.
    const detailQuery = useQuery<ContractDetail>({
        queryKey: ['grain-contracts', tenantSlug, 'detail', contract?.id],
        queryFn: async () => {
            const res = await fetch(apiUrl(`/grain/contracts/${contract!.id}`));
            if (!res.ok) throw new Error('Failed to load contract');
            return res.json();
        },
        enabled: open && Boolean(contract?.id),
        staleTime: 30_000,
    });

    // Seasons for the optional season select. Fetched lazily when the
    // modal is open.
    const seasonsQuery = useQuery<SeasonOption[]>({
        queryKey: ['grain', tenantSlug, 'seasons'],
        queryFn: async () => {
            const res = await fetch(apiUrl('/planning/seasons'));
            // 404 / 403 here means the PLANNING module is off for this
            // tenant — a different thing from "no seasons exist", and the
            // form must not conflate them.
            if (res.status === 404 || res.status === 403) {
                throw new PlanningUnavailableError();
            }
            if (!res.ok) throw new Error('Failed to load seasons');
            return res.json();
        },
        enabled: open,
        retry: false,
        staleTime: 60_000,
    });

    // Three distinct states, each said out loud rather than collapsed
    // into a lone "No season" option:
    //   • module off      → explain, and disable the picker;
    //   • load failed     → say so;
    //   • loaded + empty  → invite creating a season.
    const planningUnavailable =
        seasonsQuery.error instanceof PlanningUnavailableError;
    const seasonsFailed = seasonsQuery.isError && !planningUnavailable;
    const seasons = seasonsQuery.data ?? [];

    // Prepend a "No season" sentinel so the optional relation is
    // clearable (the Combobox has no built-in clear affordance).
    const seasonOptions: ComboboxOption[] = [
        { value: '', label: t('noSeason') },
        ...seasons.map((s) => ({ value: s.id, label: s.name })),
    ];

    const {
        register,
        handleSubmit,
        control,
        reset,
        setError: setFormError,
        setFocus,
        formState: { errors, isSubmitting },
    } = useForm<FormValues>({
        resolver: zodResolver(formSchema),
        defaultValues: DEFAULT_VALUES,
        mode: 'onTouched',
    });

    // `useWatch` (subscription-based) rather than `watch()`: the latter
    // returns a fresh function each render, so feeding its result into a
    // `useMemo` dep array is not memoization-safe.
    const watchedType = useWatch({ control, name: 'type' });
    const watchedCurrency = useWatch({ control, name: 'priceCurrency' });
    // A currency already stored but not in our offered set is kept at the
    // top rather than silently dropped on the next unrelated edit.
    const currencyChoices: ComboboxOption[] = useMemo(
        () => [
            { value: '', label: t('currencyNone') },
            ...currencyOptions(watchedCurrency ?? contract?.priceCurrency),
        ],
        [t, watchedCurrency, contract?.priceCurrency],
    );

    // Re-seed the form whenever the modal opens — from the edited contract
    // or back to empty defaults for create.
    useEffect(() => {
        if (!open) return;
        if (contract) {
            reset({
                key: contract.key ?? '',
                counterparty: contract.counterparty,
                commodity: contract.commodity ?? '',
                type: contract.type,
                status: contract.status,
                volumeTonnes: decToText(contract.volumeTonnes),
                pricePerTonne: decToText(contract.pricePerTonne),
                priceCurrency: contract.priceCurrency ?? '',
                deliveryStart: isoToDate(contract.deliveryStart),
                deliveryEnd: isoToDate(contract.deliveryEnd),
                seasonId: contract.seasonId ?? '',
                // `terms` / `pricingNotes` come from the detail fetch —
                // the list row does not carry them.
                terms: detailQuery.data?.terms ?? '',
                pricingNotes: detailQuery.data?.pricingNotes ?? '',
            });
        } else {
            reset(DEFAULT_VALUES);
        }
        const t = setTimeout(() => setFocus('counterparty'), 60);
        return () => clearTimeout(t);
    }, [open, contract, detailQuery.data, reset, setFocus]);

    const onSubmit = async (values: FormValues) => {
        try {
            const body = {
                key: values.key?.trim() || null,
                counterparty: values.counterparty.trim(),
                commodity: values.commodity?.trim() || null,
                type: values.type,
                status: values.status,
                volumeTonnes: textToNum(values.volumeTonnes),
                pricePerTonne: textToNum(values.pricePerTonne),
                priceCurrency: values.priceCurrency?.trim() || null,
                deliveryStart: values.deliveryStart
                    ? values.deliveryStart.toISOString()
                    : null,
                deliveryEnd: values.deliveryEnd
                    ? values.deliveryEnd.toISOString()
                    : null,
                seasonId: values.seasonId || null,
                terms: values.terms?.trim() || null,
                pricingNotes: values.pricingNotes?.trim() || null,
            };
            const res = await fetch(
                isEdit
                    ? apiUrl(`/grain/contracts/${contract!.id}`)
                    : apiUrl('/grain/contracts'),
                {
                    method: isEdit ? 'PATCH' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                },
            );
            if (!res.ok) {
                // The API error body is `{ error: { code, message,
                // details? } }` (see `toApiErrorResponse`). Reading
                // `data.error` as a STRING meant `typeof` was always
                // 'object', so every server rejection fell through to a
                // generic message and discarded the real one — including
                // the clean 409 on a duplicate contract number and the
                // per-field validation issues.
                const data = await res.json().catch(() => ({}));
                throw new Error(resolveApiError(data, isEdit));
            }
            queryClient.invalidateQueries({
                queryKey: ['grain-contracts', tenantSlug],
            });
            setOpen(false);
            onSaved?.();
        } catch (err) {
            setFormError('root.api', {
                type: 'api',
                message:
                    err instanceof Error
                        ? err.message
                        : `Failed to ${isEdit ? 'update' : 'create'} contract`,
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
                            id="contract-form-error"
                            role="alert"
                        >
                            {apiError}
                        </div>
                    )}

                    <div className="space-y-default">
                        <FormField
                            // The schema has always known this is a
                            // BUYER on a SALE and a SUPPLIER on a
                            // PURCHASE; the form said "Counterparty" to
                            // everyone. `type` is in hand at render time.
                            label={
                                watchedType === 'PURCHASE'
                                    ? t('supplier')
                                    : t('buyer')
                            }
                            required
                            error={errors.counterparty?.message}
                        >
                            <Input
                                id="contract-counterparty-input"
                                type="text"
                                placeholder={
                                    watchedType === 'PURCHASE'
                                        ? t('supplierPlaceholder')
                                        : t('buyerPlaceholder')
                                }
                                autoComplete="off"
                                {...register('counterparty')}
                            />
                        </FormField>

                        <FormField
                            label={t('contractNumber')}
                            hint={t('contractNumberHint')}
                            error={errors.key?.message}
                        >
                            <Input
                                id="contract-key-input"
                                type="text"
                                placeholder={t('contractNumberPlaceholder')}
                                autoComplete="off"
                                {...register('key')}
                            />
                        </FormField>

                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <FormField label={t('type')} error={errors.type?.message}>
                                <Controller
                                    control={control}
                                    name="type"
                                    render={({ field }) => (
                                        <Combobox
                                            id="contract-type-input"
                                            name="type"
                                            options={typeOptions}
                                            selected={
                                                typeOptions.find(
                                                    (o) => o.value === field.value,
                                                ) ?? null
                                            }
                                            setSelected={(o) =>
                                                field.onChange(o?.value ?? 'SALE')
                                            }
                                            placeholder={t('typePlaceholder')}
                                            hideSearch
                                            matchTriggerWidth
                                            buttonProps={{ className: 'w-full' }}
                                            caret
                                        />
                                    )}
                                />
                            </FormField>
                            <FormField
                                label={t('status')}
                                error={errors.status?.message}
                            >
                                <Controller
                                    control={control}
                                    name="status"
                                    render={({ field }) => (
                                        <Combobox
                                            id="contract-status-input"
                                            name="status"
                                            options={statusOptions}
                                            selected={
                                                statusOptions.find(
                                                    (o) => o.value === field.value,
                                                ) ?? null
                                            }
                                            setSelected={(o) =>
                                                field.onChange(o?.value ?? 'DRAFT')
                                            }
                                            placeholder={t('statusPlaceholder')}
                                            hideSearch
                                            matchTriggerWidth
                                            buttonProps={{ className: 'w-full' }}
                                            caret
                                        />
                                    )}
                                />
                            </FormField>
                        </div>

                        <FormField
                            label={t('commodity')}
                            error={errors.commodity?.message}
                        >
                            <Input
                                id="contract-commodity-input"
                                type="text"
                                placeholder={t('commodityPlaceholder')}
                                autoComplete="off"
                                {...register('commodity')}
                            />
                        </FormField>

                        <div className="grid grid-cols-1 gap-default sm:grid-cols-3">
                            <FormField
                                label={t('volume')}
                                error={errors.volumeTonnes?.message}
                            >
                                <Input
                                    id="contract-volume-input"
                                    inputMode="decimal"
                                    placeholder={t('volumePlaceholder')}
                                    autoComplete="off"
                                    {...register('volumeTonnes')}
                                />
                            </FormField>
                            <FormField
                                label={t('price')}
                                error={errors.pricePerTonne?.message}
                            >
                                <Input
                                    id="contract-price-input"
                                    inputMode="decimal"
                                    placeholder={t('pricePlaceholder')}
                                    autoComplete="off"
                                    {...register('pricePerTonne')}
                                />
                            </FormField>
                            <FormField
                                label={t('currency')}
                                error={errors.priceCurrency?.message}
                            >
                                {/* ISO-4217 picker, not free text. The org
                                    rollup groups money by this exact
                                    string, so "eur" / "EUR" / "€" used to
                                    read as three separate currencies. */}
                                <Controller
                                    control={control}
                                    name="priceCurrency"
                                    render={({ field }) => (
                                        <Combobox
                                            id="contract-currency-input"
                                            name="priceCurrency"
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

                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <FormField
                                label={t('deliveryStart')}
                                error={errors.deliveryStart?.message}
                            >
                                <Controller
                                    control={control}
                                    name="deliveryStart"
                                    render={({ field }) => (
                                        <DatePicker
                                            id="contract-delivery-start-input"
                                            value={field.value}
                                            onChange={(d) => field.onChange(d)}
                                            placeholder={t('datePlaceholder')}
                                        />
                                    )}
                                />
                            </FormField>
                            <FormField
                                label={t('deliveryEnd')}
                                error={errors.deliveryEnd?.message}
                            >
                                <Controller
                                    control={control}
                                    name="deliveryEnd"
                                    render={({ field }) => (
                                        <DatePicker
                                            id="contract-delivery-end-input"
                                            value={field.value}
                                            onChange={(d) => field.onChange(d)}
                                            placeholder={t('datePlaceholder')}
                                        />
                                    )}
                                />
                            </FormField>
                        </div>

                        <FormField
                            label={t('season')}
                            hint={
                                planningUnavailable
                                    ? t('seasonPlanningOff')
                                    : seasonsFailed
                                      ? t('seasonLoadFailed')
                                      : seasons.length === 0 && !seasonsQuery.isLoading
                                        ? t('seasonNoneYet')
                                        : t('seasonHint')
                            }
                            error={errors.seasonId?.message}
                        >
                            <Controller
                                control={control}
                                name="seasonId"
                                render={({ field }) => (
                                    <Combobox
                                        id="contract-season-input"
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
                                        disabled={planningUnavailable}
                                        matchTriggerWidth
                                        buttonProps={{ className: 'w-full' }}
                                        caret
                                    />
                                )}
                            />
                        </FormField>

                        <FormField label={t('terms')} error={errors.terms?.message}>
                            <Textarea
                                id="contract-terms-input"
                                // 20 000-char column: two rows showed
                                // roughly one line of a negotiated
                                // contract.
                                rows={8}
                                placeholder={t('termsPlaceholder')}
                                {...register('terms')}
                            />
                        </FormField>

                        <FormField
                            label={t('pricingNotes')}
                            // "Basis" is the term of art this field is
                            // for; spelling it out costs one tooltip.
                            hint={tContracts('jargonBasis')}
                            error={errors.pricingNotes?.message}
                        >
                            <Textarea
                                id="contract-pricing-notes-input"
                                rows={4}
                                placeholder={t('pricingNotesPlaceholder')}
                                {...register('pricingNotes')}
                            />
                        </FormField>
                    </div>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        id="contract-cancel-btn"
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
                        id="save-contract-btn"
                        loading={isSubmitting}
                    >
                        {isEdit ? t('saveContract') : t('createContract')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
