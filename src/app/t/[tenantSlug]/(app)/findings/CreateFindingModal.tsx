'use client';

/**
 * Create-finding modal.
 *
 * Replaces the inline create form on the findings list with a modal that
 * captures the full finding shape: title/description/type/severity/due
 * date PLUS an assignee (tenant member), a linked control, a compensating
 * control, and a free-text analysis.
 *
 * Business contract — POST /api/t/:slug/findings with
 *   { title, description, severity, type, dueDate?, analysis?,
 *     assigneeUserId?, controlId?, compensatingControlId? }
 * The server validates every referenced id against the tenant. On success
 * the findings list cache is invalidated.
 */
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type Dispatch,
    type SetStateAction,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import type { CappedList } from '@/lib/list-backfill-cap';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { FormSection } from '@/components/ui/form-section';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { UserCombobox } from '@/components/ui/user-combobox';
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import {
    parseYMD,
    startOfUtcDay,
    toYMD,
} from '@/components/ui/date-picker/date-utils';
import { useFormTelemetry } from '@/lib/telemetry/form-telemetry';
import { useTranslations } from 'next-intl';

interface ControlOption {
    id: string;
    code: string | null;
    name: string;
}

const SEVERITY_OPTIONS: ComboboxOption[] = [
    { value: 'LOW', label: 'Low' },
    { value: 'MEDIUM', label: 'Medium' },
    { value: 'HIGH', label: 'High' },
    { value: 'CRITICAL', label: 'Critical' },
];

const TYPE_OPTIONS: ComboboxOption[] = [
    { value: 'NONCONFORMITY', label: 'Nonconformity' },
    { value: 'OBSERVATION', label: 'Observation' },
    { value: 'OPPORTUNITY', label: 'Opportunity' },
];

const EMPTY_FORM = {
    title: '',
    description: '',
    severity: 'MEDIUM',
    type: 'OBSERVATION',
    assigneeUserId: '',
    controlId: '',
    compensatingControlId: '',
    analysis: '',
    dueDate: '',
};

export interface CreateFindingModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    tenantSlug: string;
    apiUrl: (path: string) => string;
}

export function CreateFindingModal({
    open,
    setOpen,
    tenantSlug,
    apiUrl,
}: CreateFindingModalProps) {
    const close = useCallback(() => setOpen(false), [setOpen]);
    const queryClient = useQueryClient();
    const titleRef = useRef<HTMLInputElement>(null);
    const telemetry = useFormTelemetry('CreateFindingModal');
    const t = useTranslations('findings.createModal');

    const [form, setForm] = useState({ ...EMPTY_FORM });
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');

    const update = <K extends keyof typeof form>(field: K, value: (typeof form)[K]) =>
        setForm((prev) => ({ ...prev, [field]: value }));

    // ── Lookups load while the modal is open ──
    const controlsQuery = useQuery<ControlOption[]>({
        queryKey: ['findings', tenantSlug, 'controls-for-new-finding'],
        enabled: open,
        queryFn: async () => {
            const res = await fetch(apiUrl('/controls'));
            if (!res.ok) throw new Error(`Controls: ${res.status}`);
            const data = await res.json();
            if (!Array.isArray(data)) return [];
            return data.map((c: ControlOption) => ({
                id: c.id,
                code: c.code ?? null,
                name: c.name,
            }));
        },
    });
    const controls = useMemo(() => controlsQuery.data ?? [], [controlsQuery.data]);

    const controlOptions = useMemo<ComboboxOption[]>(
        () =>
            controls.map((c) => ({
                value: c.id,
                label: c.code ? `${c.code} · ${c.name}` : c.name,
            })),
        [controls],
    );

    // ── Reset + focus on open ──
    useEffect(() => {
        if (!open) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setForm({ ...EMPTY_FORM });
        setError('');
        setSubmitting(false);
        const t = setTimeout(() => titleRef.current?.focus(), 60);
        return () => clearTimeout(t);
    }, [open]);

    const canSubmit =
        form.title.trim().length > 0 &&
        form.description.trim().length > 0 &&
        !submitting;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!canSubmit) return;
        setSubmitting(true);
        setError('');
        telemetry.trackSubmit({
            severity: form.severity,
            type: form.type,
            hasAssignee: Boolean(form.assigneeUserId),
            hasControl: Boolean(form.controlId),
            hasCompensatingControl: Boolean(form.compensatingControlId),
        });
        try {
            const payload: Record<string, unknown> = {
                title: form.title.trim(),
                description: form.description.trim(),
                severity: form.severity,
                type: form.type,
                assigneeUserId: form.assigneeUserId || undefined,
                controlId: form.controlId || undefined,
                compensatingControlId: form.compensatingControlId || undefined,
                analysis: form.analysis.trim() || undefined,
            };
            if (form.dueDate) payload.dueDate = form.dueDate;

            const res = await fetch(apiUrl('/findings'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(
                    data.message || data.error || `Failed to create finding (${res.status})`,
                );
            }
            const finding = await res.json();
            queryClient.invalidateQueries({ queryKey: queryKeys.findings.all(tenantSlug) });
            telemetry.trackSuccess({ findingId: finding.id });
            close();
        } catch (err) {
            telemetry.trackError(err);
            setError(err instanceof Error ? err.message : 'Failed to create finding');
            setSubmitting(false);
        }
    };

    return (
        <Modal
            showModal={open}
            setShowModal={setOpen}
            size="lg"
            title={t('modalTitle')}
            description={t('modalDescription')}
            preventDefaultClose={submitting}
        >
            <Modal.Header
                title={t('modalTitle')}
                description={t('modalHeaderDescription')}
            />
            <Modal.Form id="create-finding-form" onSubmit={handleSubmit}>
                <Modal.Body>
                    {error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="create-finding-error"
                            role="alert"
                            data-testid="create-finding-error"
                        >
                            {error}
                        </div>
                    )}

                    <fieldset disabled={submitting} className="m-0 border-0 p-0">
                        <FormSection eyebrow={t('sectionDetails')}>
                            <FormField label={t('fieldTitle')} required>
                                <Input
                                    id="finding-title"
                                    ref={titleRef}
                                    type="text"
                                    placeholder={t('titlePlaceholder')}
                                    value={form.title}
                                    onChange={(e) => update('title', e.target.value)}
                                    required
                                    autoComplete="off"
                                />
                            </FormField>

                            <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                                <FormField label={t('fieldType')}>
                                    <Combobox
                                        id="finding-type"
                                        name="type"
                                        options={TYPE_OPTIONS}
                                        selected={TYPE_OPTIONS.find((o) => o.value === form.type) ?? null}
                                        setSelected={(o) => update('type', o?.value ?? 'OBSERVATION')}
                                        hideSearch
                                        matchTriggerWidth
                                        buttonProps={{ className: 'w-full' }}
                                        caret
                                    />
                                </FormField>
                                <FormField label={t('fieldSeverity')}>
                                    <Combobox
                                        id="finding-severity"
                                        name="severity"
                                        options={SEVERITY_OPTIONS}
                                        selected={SEVERITY_OPTIONS.find((o) => o.value === form.severity) ?? null}
                                        setSelected={(o) => update('severity', o?.value ?? 'MEDIUM')}
                                        hideSearch
                                        matchTriggerWidth
                                        buttonProps={{ className: 'w-full' }}
                                        caret
                                    />
                                </FormField>
                            </div>

                            <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                                <FormField label={t('fieldAssignee')}>
                                    <UserCombobox
                                        tenantSlug={tenantSlug}
                                        selectedId={form.assigneeUserId || null}
                                        onChange={(userId) => update('assigneeUserId', userId ?? '')}
                                        matchTriggerWidth
                                        id="finding-assignee"
                                        placeholder={t('unassigned')}
                                    />
                                </FormField>
                                <FormField label={t('fieldDueDate')}>
                                    <DatePicker
                                        id="finding-due-date"
                                        className="w-full"
                                        placeholder={t('datePlaceholder')}
                                        clearable
                                        align="start"
                                        value={parseYMD(form.dueDate)}
                                        onChange={(next) => update('dueDate', toYMD(next) ?? '')}
                                        disabledDays={{ before: startOfUtcDay(new Date()) }}
                                        aria-label={t('dueDateAria')}
                                    />
                                </FormField>
                            </div>

                            <FormField label={t('fieldDescription')} required>
                                <Textarea
                                    id="finding-description"
                                    rows={3}
                                    placeholder={t('descriptionPlaceholder')}
                                    value={form.description}
                                    onChange={(e) => update('description', e.target.value)}
                                    required
                                />
                            </FormField>
                        </FormSection>

                        <FormSection eyebrow={t('sectionControls')}>
                            <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                                <FormField
                                    label={t('fieldLinkedControl')}
                                    description={t('linkedControlDescription')}
                                >
                                    <Combobox
                                        id="finding-control"
                                        name="controlId"
                                        options={controlOptions}
                                        selected={controlOptions.find((o) => o.value === form.controlId) ?? null}
                                        setSelected={(o) => update('controlId', o?.value ?? '')}
                                        loading={controlsQuery.isLoading}
                                        placeholder={t('controlNone')}
                                        searchPlaceholder={t('controlSearch')}
                                        emptyState={t('controlEmpty')}
                                        matchTriggerWidth
                                        buttonProps={{ className: 'w-full' }}
                                        caret
                                    />
                                </FormField>
                                <FormField
                                    label={t('fieldCompensatingControl')}
                                    description={t('compensatingControlDescription')}
                                >
                                    <Combobox
                                        id="finding-compensating-control"
                                        name="compensatingControlId"
                                        options={controlOptions}
                                        selected={
                                            controlOptions.find((o) => o.value === form.compensatingControlId) ?? null
                                        }
                                        setSelected={(o) => update('compensatingControlId', o?.value ?? '')}
                                        loading={controlsQuery.isLoading}
                                        placeholder={t('controlNone')}
                                        searchPlaceholder={t('controlSearch')}
                                        emptyState={t('controlEmpty')}
                                        matchTriggerWidth
                                        buttonProps={{ className: 'w-full' }}
                                        caret
                                    />
                                </FormField>
                            </div>

                        </FormSection>

                        <FormSection eyebrow={t('sectionAnalysis')}>
                            <FormField
                                label={t('fieldAnalysis')}
                                description={t('analysisDescription')}
                            >
                                <Textarea
                                    id="finding-analysis"
                                    rows={3}
                                    placeholder={t('analysisPlaceholder')}
                                    value={form.analysis}
                                    onChange={(e) => update('analysis', e.target.value)}
                                />
                            </FormField>
                        </FormSection>
                    </fieldset>
                </Modal.Body>

                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        id="create-finding-cancel-btn"
                        onClick={() => {
                            if (!submitting) close();
                        }}
                        disabled={submitting}
                    >
                        {t('cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        id="submit-finding"
                        disabled={!canSubmit}
                    >
                        {submitting ? t('creating') : t('createFinding')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
