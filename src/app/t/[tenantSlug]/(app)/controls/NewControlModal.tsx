'use client';

/**
 * Epic 54 — Create Control modal.
 *
 * Modal-based version of the legacy `/controls/new` full-page form.
 * Mounts inside the Controls list so users don't lose their table
 * state, filters, or scroll position when opening "New Control".
 *
 * Form pattern (Epic 64-FORM):
 *   - `useForm` + `zodResolver` for state + validation
 *   - `<FormField>` wraps each control (Label + error + a11y wiring)
 *   - `register(...)` for plain inputs / textareas
 *   - `<Controller>` for the Combobox primitives (they own their own
 *     value/onChange contract)
 *
 * This is the canonical example of how to build a non-trivial form on
 * the shared form foundation. Mirror this shape when migrating
 * `NewRiskModal`, `NewTaskPage`, etc.
 *
 * Business behaviour is unchanged from the previous useState shape:
 *   - POST /api/t/:slug/controls with the same payload
 *   - Optional NOT_APPLICABLE applicability update on the created control
 *   - On success, invalidate the React-Query cache and route to the
 *     new control's detail page
 *   - Form IDs (#control-name-input, …, #create-control-btn) are
 *     preserved so existing E2E suites pass untouched.
 */

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import {
    useCallback,
    useEffect,
    type Dispatch,
    type SetStateAction,
} from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { UserCombobox } from '@/components/ui/user-combobox';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { InfoTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { useFormTelemetry } from '@/lib/telemetry/form-telemetry';

// ─── Options ─────────────────────────────────────────────────────────

const FREQUENCY_OPTIONS: ComboboxOption[] = [
    { value: 'AD_HOC', label: 'Ad Hoc' },
    { value: 'DAILY', label: 'Daily' },
    { value: 'WEEKLY', label: 'Weekly' },
    { value: 'MONTHLY', label: 'Monthly' },
    { value: 'QUARTERLY', label: 'Quarterly' },
    { value: 'ANNUALLY', label: 'Annually' },
];

// Mirror of EditControlModal's classification options (the Prisma
// enum is the source of truth — keep these two lists in sync).
const MITIGATION_TYPE_OPTIONS: ComboboxOption[] = [
    { value: 'PREVENTIVE', label: 'Preventive' },
    { value: 'DETECTIVE', label: 'Detective' },
    { value: 'DETERRENT', label: 'Deterrent' },
    { value: 'CORRECTIVE', label: 'Corrective' },
    { value: 'COMPENSATING', label: 'Compensating' },
];

const CATEGORY_OPTIONS: ComboboxOption[] = [
    { value: 'Access Control', label: 'Access Control' },
    { value: 'Encryption', label: 'Encryption' },
    { value: 'Network Security', label: 'Network Security' },
    { value: 'Physical Security', label: 'Physical Security' },
    { value: 'HR Security', label: 'HR Security' },
    { value: 'Operations', label: 'Operations' },
    { value: 'Compliance', label: 'Compliance' },
    { value: 'Incident Management', label: 'Incident Management' },
    { value: 'Business Continuity', label: 'Business Continuity' },
    { value: 'Other', label: 'Other' },
];

// ─── Schema ──────────────────────────────────────────────────────────
//
// Zod schema is the source of truth for the form contract. Server-side
// validation lives in `src/app-layer/schemas/control.schemas.ts`; the
// client form intentionally enforces a SUBSET (name required + the
// not-applicable-needs-justification rule). Cross-field validation runs
// in `superRefine` so the error is attached to the right field.

const formSchema = z
    .object({
        code: z.string().max(64).optional(),
        name: z.string().min(1, 'Name is required'),
        description: z.string().optional(),
        category: z.string().optional(),
        frequency: z.string().optional(),
        ownerUserId: z.string().optional(),
        mitigationType: z.string().optional(),
        applicability: z.enum(['APPLICABLE', 'NOT_APPLICABLE']),
        justification: z.string().optional(),
    })
    .superRefine((data, ctx) => {
        if (
            data.applicability === 'NOT_APPLICABLE' &&
            !data.justification?.trim()
        ) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['justification'],
                message: 'Justification is required for non-applicable controls.',
            });
        }
    });

type FormValues = z.infer<typeof formSchema>;

const DEFAULT_VALUES: FormValues = {
    code: '',
    name: '',
    description: '',
    category: '',
    frequency: '',
    ownerUserId: '',
    mitigationType: '',
    applicability: 'APPLICABLE',
    justification: '',
};

// ─── Component ───────────────────────────────────────────────────────

export interface NewControlModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    /**
     * Tenant slug for react-query invalidation. The mutation already
     * uses tenant-scoped apiUrl helpers; this is only used for keys.
     */
    tenantSlug: string;
}

export function NewControlModal({ open, setOpen, tenantSlug }: NewControlModalProps) {
    const t = useTranslations('controls');
    const close = useCallback(() => setOpen(false), [setOpen]);
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const router = useRouter();
    const queryClient = useQueryClient();
    const telemetry = useFormTelemetry('NewControlModal');

    const {
        register,
        handleSubmit,
        control,
        watch,
        reset,
        setError: setFormError,
        setFocus,
        formState: { errors, isSubmitting },
    } = useForm<FormValues>({
        resolver: zodResolver(formSchema),
        defaultValues: DEFAULT_VALUES,
        mode: 'onTouched',
    });

    // react-hook-form's `watch` triggers a re-subscription on every call;
    // the React Compiler rule flags it as incompatible-library because
    // it's not designed for the new strict reactivity model. Working as
    // intended in production.
    // eslint-disable-next-line react-hooks/incompatible-library
    const applicability = watch('applicability');
    // Watch name so the submit button can mirror the legacy disabled
    // gate (`disabled until name is non-empty`). RHF's `formState.isValid`
    // is unreliable under `mode: 'onTouched'` for the initial render
    // (true before the user touches anything); explicit watch matches
    // the documented E2E selector + assertion.
    const nameValue = watch('name');
    const justificationValue = watch('justification');
    const submitDisabled =
        isSubmitting ||
        nameValue.trim().length === 0 ||
        (applicability === 'NOT_APPLICABLE' &&
            (justificationValue?.trim().length ?? 0) === 0);

    // Reset form + focus the name input each time the modal opens.
    useEffect(() => {
        if (!open) return;
        reset(DEFAULT_VALUES);
        // Give Radix's focus manager a beat before we override.
        const t = setTimeout(() => setFocus('name'), 60);
        return () => clearTimeout(t);
    }, [open, reset, setFocus]);

    const onSubmit = async (values: FormValues) => {
        telemetry.trackSubmit({
            applicability: values.applicability,
            hasCategory: Boolean(values.category),
            hasFrequency: Boolean(values.frequency),
        });
        try {
            const body = {
                name: values.name.trim(),
                code: values.code?.trim() || undefined,
                description: values.description?.trim() || undefined,
                category: values.category || undefined,
                frequency: values.frequency || undefined,
                ownerUserId: values.ownerUserId || undefined,
                mitigationType: values.mitigationType || undefined,
                isCustom: true,
            };
            const res = await fetch(apiUrl('/controls'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                const msg =
                    typeof data.error === 'string'
                        ? data.error
                        : data.message || 'Failed to create control';
                throw new Error(msg);
            }
            const created = await res.json();

            if (
                values.applicability === 'NOT_APPLICABLE' &&
                values.justification?.trim()
            ) {
                await fetch(apiUrl(`/controls/${created.id}/applicability`), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        applicability: 'NOT_APPLICABLE',
                        justification: values.justification,
                    }),
                });
            }

            queryClient.invalidateQueries({
                queryKey: queryKeys.controls.all(tenantSlug),
            });

            telemetry.trackSuccess({ controlId: created.id });
            close();
            router.push(tenantHref(`/controls/${created.id}`));
        } catch (err) {
            telemetry.trackError(err);
            // Surface API errors via RHF's root-error slot so the same
            // banner pattern works for client + server failures.
            setFormError('root.api', {
                type: 'api',
                message:
                    err instanceof Error
                        ? err.message
                        : 'Failed to create control',
            });
        }
    };

    const apiError = errors.root?.api?.message;

    return (
        <Modal
            showModal={open}
            setShowModal={setOpen}
            size="lg"
            title={t('newModal.title')}
            description={t('newModal.description')}
            preventDefaultClose={isSubmitting}
        >
            <Modal.Header
                title={t('newModal.headerTitle')}
                description={t('newModal.description')}
            />
            <Modal.Form onSubmit={handleSubmit(onSubmit)}>
                <Modal.Body>
                    {apiError && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="new-control-error"
                            role="alert"
                        >
                            {apiError}
                        </div>
                    )}

                    <div className="space-y-default">
                        <FormField label={t('newModal.code')} error={errors.code?.message}>
                            <Input
                                id="control-code-input"
                                type="text"
                                placeholder={t('newModal.phCode')}
                                autoComplete="off"
                                {...register('code')}
                            />
                        </FormField>
                        <FormField
                            label={t('newModal.name')}
                            required
                            error={errors.name?.message}
                        >
                            <Input
                                id="control-name-input"
                                type="text"
                                placeholder={t('newModal.phName')}
                                autoComplete="off"
                                {...register('name')}
                            />
                        </FormField>
                        <FormField
                            label={t('newModal.descriptionLabel')}
                            error={errors.description?.message}
                        >
                            <Textarea
                                id="control-description-input"
                                rows={3}
                                placeholder={t('newModal.phDescription')}
                                {...register('description')}
                            />
                        </FormField>
                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <FormField
                                label={t('newModal.category')}
                                error={errors.category?.message}
                            >
                                <Controller
                                    control={control}
                                    name="category"
                                    render={({ field }) => (
                                        <Combobox
                                            id="control-category-input"
                                            name="category"
                                            options={CATEGORY_OPTIONS}
                                            selected={
                                                CATEGORY_OPTIONS.find(
                                                    (o) => o.value === field.value,
                                                ) ?? null
                                            }
                                            setSelected={(o) =>
                                                field.onChange(o?.value ?? '')
                                            }
                                            placeholder={t('newModal.phCategory')}
                                            searchPlaceholder={t('newModal.searchCategories')}
                                            matchTriggerWidth
                                            buttonProps={{ className: 'w-full' }}
                                            caret
                                        />
                                    )}
                                />
                            </FormField>
                            <FormField
                                label={t('newModal.frequency')}
                                hint={t('newModal.frequencyHint')}
                                error={errors.frequency?.message}
                            >
                                <Controller
                                    control={control}
                                    name="frequency"
                                    render={({ field }) => (
                                        <Combobox
                                            id="control-frequency-input"
                                            name="frequency"
                                            options={FREQUENCY_OPTIONS}
                                            selected={
                                                FREQUENCY_OPTIONS.find(
                                                    (o) => o.value === field.value,
                                                ) ?? null
                                            }
                                            setSelected={(o) =>
                                                field.onChange(o?.value ?? '')
                                            }
                                            placeholder={t('newModal.phFrequency')}
                                            hideSearch
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
                                label={t('newModal.mitigationType')}
                                error={errors.mitigationType?.message}
                            >
                                <Controller
                                    control={control}
                                    name="mitigationType"
                                    render={({ field }) => (
                                        <Combobox
                                            id="control-mitigation-type-input"
                                            name="mitigationType"
                                            options={MITIGATION_TYPE_OPTIONS}
                                            selected={
                                                MITIGATION_TYPE_OPTIONS.find(
                                                    (o) => o.value === field.value,
                                                ) ?? null
                                            }
                                            setSelected={(o) =>
                                                field.onChange(o?.value ?? '')
                                            }
                                            placeholder={t('newModal.phMitigation')}
                                            hideSearch
                                            matchTriggerWidth
                                            buttonProps={{ className: 'w-full' }}
                                            caret
                                        />
                                    )}
                                />
                            </FormField>
                        </div>
                        <FormField label={t('newModal.owner')} error={errors.ownerUserId?.message}>
                            <Controller
                                control={control}
                                name="ownerUserId"
                                render={({ field }) => (
                                    <UserCombobox
                                        id="control-owner-input"
                                        name="ownerUserId"
                                        tenantSlug={tenantSlug}
                                        selectedId={field.value || null}
                                        onChange={(userId) =>
                                            field.onChange(userId ?? '')
                                        }
                                        placeholder={t('newModal.unassigned')}
                                    />
                                )}
                            />
                        </FormField>
                        <div role="group" aria-labelledby="applicability-legend">
                            <div className="mb-1 flex items-center gap-1.5">
                                <span
                                    id="applicability-legend"
                                    className="text-sm text-content-default"
                                >
                                    {t('newModal.applicability')}
                                </span>
                                <InfoTooltip
                                    aria-label={t('newModal.applicabilityInfoAria')}
                                    iconClassName="h-3.5 w-3.5"
                                    content={t('newModal.applicabilityInfo')}
                                />
                            </div>
                            <div className="flex gap-default">
                                <label className="flex items-center gap-tight text-sm text-content-default">
                                    <input
                                        type="radio"
                                        value="APPLICABLE"
                                        {...register('applicability')}
                                    />
                                    {t('newModal.applicable')}
                                </label>
                                <label className="flex items-center gap-tight text-sm text-content-default">
                                    <input
                                        type="radio"
                                        value="NOT_APPLICABLE"
                                        {...register('applicability')}
                                    />
                                    {t('newModal.notApplicable')}
                                </label>
                            </div>
                            {applicability === 'NOT_APPLICABLE' && (
                                <FormField
                                    label=""
                                    error={errors.justification?.message}
                                    className="mt-2"
                                >
                                    <Textarea
                                        id="control-justification-input"
                                        rows={2}
                                        placeholder={t('newModal.justificationPlaceholder')}
                                        aria-label={t('newModal.justificationAria')}
                                        {...register('justification')}
                                    />
                                </FormField>
                            )}
                        </div>
                    </div>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        id="new-control-cancel-btn"
                        onClick={() => {
                            if (!isSubmitting) close();
                        }}
                        disabled={isSubmitting}
                    >
                        {t('newModal.cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        id="create-control-btn"
                        disabled={submitDisabled}
                    >
                        {isSubmitting ? t('newModal.creating') : t('newModal.create')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
