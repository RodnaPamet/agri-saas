'use client';

/**
 * Visual rule builder (Automation Epic 3).
 *
 * A three-step Modal that lets an admin configure an automation rule without
 * writing JSON — the primary gap vs Archer's GUI workflow designer.
 *
 *   Step 1 — Trigger:    name + event picker (grouped by domain)
 *   Step 2 — Conditions: field = value rows (equality at Epic 3; Epic 4 adds
 *                        operators + AND/OR groups)
 *   Step 3 — Action:     action type + typed sub-form per type
 *
 * Save POSTs (create) or PUTs (edit) to the rules API and revalidates the
 * list cache. Server-side Zod (automation.schemas.ts) is the authoritative
 * validation; the modal does light client-side gating to drive Next/Save.
 */
import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { useSWRConfig } from 'swr';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { UserCombobox } from '@/components/ui/user-combobox';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { CACHE_KEYS } from '@/lib/swr-keys';
import {
    EVENT_LABELS,
    eventOptionsByDomain,
    filterFieldsForEvent,
} from '@/lib/automation/event-labels';
import type { AutomationRuleRow } from '@/components/processes/types';

type ActionType = 'NOTIFY_USER' | 'CREATE_TASK' | 'UPDATE_STATUS' | 'WEBHOOK';

type Operator = 'eq' | 'neq' | 'in' | 'not_in' | 'gt' | 'lt' | 'contains';

interface Condition {
    field: string;
    operator: Operator;
    value: string;
}

const OPERATOR_VALUES: readonly Operator[] = [
    'eq',
    'neq',
    'in',
    'not_in',
    'gt',
    'lt',
    'contains',
];

interface BuilderState {
    name: string;
    triggerEvent: string;
    logic: 'AND' | 'OR';
    conditions: Condition[];
    actionType: ActionType;
    notify: { userIds: string[]; message: string };
    task: { title: string; severity: string; priority: string };
    status: { entityType: string; field: string; toStatus: string };
    webhook: { url: string; method: string };
    /** Optional SLA window in minutes (Epic 5); empty = no SLA. */
    slaWindowMinutes: string;
    /** Optional chain target (Epic 7); empty = terminal rule. */
    nextRuleId: string;
    nextRuleDelay: string;
}

const EMPTY: BuilderState = {
    name: '',
    triggerEvent: '',
    logic: 'AND',
    conditions: [],
    actionType: 'NOTIFY_USER',
    notify: { userIds: [], message: '' },
    task: { title: '', severity: '', priority: '' },
    status: { entityType: 'Risk', field: 'status', toStatus: '' },
    webhook: { url: '', method: 'POST' },
    slaWindowMinutes: '',
    nextRuleId: '',
    nextRuleDelay: '',
};

const triggerOptions: ComboboxOption[] = eventOptionsByDomain().flatMap((g) =>
    g.events.map((ev) => ({ value: ev.name, label: ev.label })),
);

export interface RuleBuilderModalProps {
    tenantSlug: string;
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    /** When set, the modal edits this rule (PUT); otherwise it creates (POST). */
    editRule?: AutomationRuleRow | null;
}

export function RuleBuilderModal({ tenantSlug, open, setOpen, editRule }: RuleBuilderModalProps) {
    const t = useTranslations('ui');
    const tCommon = useTranslations('common');
    const apiUrl = useTenantApiUrl();
    const { mutate } = useSWRConfig();
    const actionOptions: ReadonlyArray<{ value: ActionType; label: string; hint: string }> = [
        { value: 'NOTIFY_USER', label: t('automationInspector.actionNotifyUser'), hint: t('ruleBuilder.notifyHint') },
        { value: 'CREATE_TASK', label: t('automationInspector.actionCreateTask'), hint: t('ruleBuilder.createTaskHint') },
        { value: 'UPDATE_STATUS', label: t('automationInspector.actionUpdateStatus'), hint: t('ruleBuilder.updateStatusHint') },
        { value: 'WEBHOOK', label: t('automationInspector.actionWebhook'), hint: t('ruleBuilder.webhookHint') },
    ];
    // Epic 7 — chain targets (other rules). Excludes the rule being edited.
    const { data: allRules } = useTenantSWR<AutomationRuleRow[]>(
        CACHE_KEYS.automation.rules.list(),
    );
    const chainOptions: ComboboxOption[] = (allRules ?? [])
        .filter((r) => r.id !== editRule?.id)
        .map((r) => ({ value: r.id, label: r.name }));
    const [step, setStep] = useState<1 | 2 | 3>(1);
    const [form, setForm] = useState<BuilderState>(EMPTY);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const patch = (p: Partial<BuilderState>) => setForm((f) => ({ ...f, ...p }));

    const availableFields = useMemo(
        () => filterFieldsForEvent(form.triggerEvent),
        [form.triggerEvent],
    );

    const step1Valid = form.name.trim().length > 0 && form.triggerEvent.length > 0;
    const step3Valid = (() => {
        switch (form.actionType) {
            case 'NOTIFY_USER':
                return form.notify.userIds.length > 0 && form.notify.message.trim().length > 0;
            case 'CREATE_TASK':
                return form.task.title.trim().length > 0;
            case 'UPDATE_STATUS':
                return form.status.toStatus.trim().length > 0;
            case 'WEBHOOK':
                return /^https?:\/\//.test(form.webhook.url.trim());
        }
    })();

    function buildActionConfig(): Record<string, unknown> {
        switch (form.actionType) {
            case 'NOTIFY_USER':
                return { userIds: form.notify.userIds, message: form.notify.message.trim() };
            case 'CREATE_TASK':
                return {
                    title: form.task.title.trim(),
                    ...(form.task.severity ? { severity: form.task.severity } : {}),
                    ...(form.task.priority ? { priority: form.task.priority } : {}),
                };
            case 'UPDATE_STATUS':
                return {
                    entityType: form.status.entityType,
                    field: form.status.field,
                    toStatus: form.status.toStatus.trim(),
                };
            case 'WEBHOOK':
                return { url: form.webhook.url.trim(), method: form.webhook.method };
        }
    }

    function buildTriggerFilter():
        | {
              logic: 'AND' | 'OR';
              conditions: Array<{ field: string; operator: Operator; value: string | string[] }>;
          }
        | null {
        const valid = form.conditions.filter((c) => c.field && c.value !== '');
        if (valid.length === 0) return null;
        return {
            logic: form.logic,
            conditions: valid.map((c) => ({
                field: c.field,
                operator: c.operator,
                // in/not_in take a value set — split the comma-separated input.
                value:
                    c.operator === 'in' || c.operator === 'not_in'
                        ? c.value.split(',').map((s) => s.trim()).filter(Boolean)
                        : c.value,
            })),
        };
    }

    async function handleSave() {
        setSubmitting(true);
        setError(null);
        try {
            const payload = {
                name: form.name.trim(),
                triggerEvent: form.triggerEvent,
                triggerFilter: buildTriggerFilter(),
                actionType: form.actionType,
                actionConfig: buildActionConfig(),
                slaWindowMinutes: form.slaWindowMinutes
                    ? Number(form.slaWindowMinutes)
                    : null,
                nextRuleId: form.nextRuleId || null,
                nextRuleDelay: form.nextRuleDelay ? Number(form.nextRuleDelay) : null,
            };
            const url = editRule
                ? apiUrl(CACHE_KEYS.automation.rules.detail(editRule.id))
                : apiUrl(CACHE_KEYS.automation.rules.list());
            const res = await fetch(url, {
                method: editRule ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                const e = await res.json().catch(() => ({ error: t('ruleBuilder.saveFailed') }));
                throw new Error(e.error ?? t('ruleBuilder.saveFailed'));
            }
            await mutate(apiUrl(CACHE_KEYS.automation.rules.list()));
            setOpen(false);
            setForm(EMPTY);
            setStep(1);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('ruleBuilder.saveFailed'));
        } finally {
            setSubmitting(false);
        }
    }

    const triggerSelected = form.triggerEvent
        ? triggerOptions.find((o) => o.value === form.triggerEvent) ?? null
        : null;

    return (
        <Modal showModal={open} setShowModal={setOpen} title={editRule ? t('ruleBuilder.editRule') : t('ruleBuilder.newRule')} size="lg">
            <Modal.Header title={editRule ? t('ruleBuilder.editRuleTitle') : t('ruleBuilder.newRuleTitle')} />
            <Modal.Body>
                <p className="mb-default text-xs uppercase tracking-wide text-content-subtle">
                    {t('ruleBuilder.stepLine', {
                        step,
                        name:
                            step === 1
                                ? t('ruleBuilder.stepTrigger')
                                : step === 2
                                  ? t('ruleBuilder.stepConditions')
                                  : t('ruleBuilder.stepAction'),
                    })}
                </p>

                {step === 1 && (
                    <div className="space-y-default">
                        <FormField label={t('automationInspector.ruleName')} required>
                            <Input
                                value={form.name}
                                onChange={(e) => patch({ name: e.target.value })}
                                placeholder={t('ruleBuilder.namePlaceholder')}
                            />
                        </FormField>
                        <FormField label={t('automationInspector.triggerEvent')} required>
                            <Combobox
                                options={triggerOptions}
                                selected={triggerSelected}
                                setSelected={(o) => patch({ triggerEvent: o?.value ?? '', conditions: [] })}
                                placeholder={t('ruleBuilder.selectEvent')}
                                matchTriggerWidth
                                optionDescription={(o) =>
                                    EVENT_LABELS[o.value as keyof typeof EVENT_LABELS]?.description ?? ''
                                }
                            />
                        </FormField>
                    </div>
                )}

                {step === 2 && (
                    <div className="space-y-default">
                        {availableFields.length === 0 ? (
                            <p className="text-sm text-content-muted">
                                {t('ruleBuilder.eventFieldsHint')}
                            </p>
                        ) : (
                            <>
                                {/* AND/OR group logic — shown once ≥2 conditions exist. */}
                                {form.conditions.length > 1 && (
                                    <div className="flex items-center gap-compact text-sm">
                                        <span className="text-content-muted">{t('ruleBuilder.match')}</span>
                                        <RadioGroup
                                            value={form.logic}
                                            onValueChange={(v) => patch({ logic: v as 'AND' | 'OR' })}
                                            className="flex gap-default"
                                        >
                                            <label className="flex items-center gap-tight">
                                                <RadioGroupItem value="AND" /> {t('ruleBuilder.allAnd')}
                                            </label>
                                            <label className="flex items-center gap-tight">
                                                <RadioGroupItem value="OR" /> {t('ruleBuilder.anyOr')}
                                            </label>
                                        </RadioGroup>
                                    </div>
                                )}
                                {form.conditions.map((cond, i) => {
                                    const fieldDef = availableFields.find((f) => f.field === cond.field);
                                    const isSet = cond.operator === 'in' || cond.operator === 'not_in';
                                    return (
                                        <div key={i} className="flex items-end gap-compact">
                                            <FormField label={i === 0 ? t('ruleBuilder.field') : undefined} className="flex-1">
                                                <Combobox
                                                    options={availableFields.map((f) => ({
                                                        value: f.field,
                                                        label: f.label,
                                                    }))}
                                                    selected={
                                                        cond.field
                                                            ? { value: cond.field, label: fieldDef?.label ?? cond.field }
                                                            : null
                                                    }
                                                    setSelected={(o) => {
                                                        const next = [...form.conditions];
                                                        next[i] = { ...next[i], field: o?.value ?? '', value: '' };
                                                        patch({ conditions: next });
                                                    }}
                                                    placeholder={t('ruleBuilder.fieldPlaceholder')}
                                                    matchTriggerWidth
                                                />
                                            </FormField>
                                            <FormField label={i === 0 ? t('ruleBuilder.operator') : undefined}>
                                                <Combobox
                                                    options={OPERATOR_VALUES.map((op) => ({
                                                        value: op,
                                                        label: t(`ruleBuilder.op.${op}`),
                                                    }))}
                                                    selected={{
                                                        value: cond.operator,
                                                        label: t(`ruleBuilder.op.${cond.operator}`),
                                                    }}
                                                    setSelected={(o) => {
                                                        const next = [...form.conditions];
                                                        next[i] = {
                                                            ...next[i],
                                                            operator: (o?.value as Operator) ?? 'eq',
                                                        };
                                                        patch({ conditions: next });
                                                    }}
                                                    matchTriggerWidth
                                                />
                                            </FormField>
                                            <FormField label={i === 0 ? t('ruleBuilder.value') : undefined} className="flex-1">
                                                {fieldDef?.type === 'enum' && !isSet ? (
                                                    <Combobox
                                                        options={(fieldDef.options ?? []).map((opt) => ({
                                                            value: opt.value,
                                                            label: opt.label,
                                                        }))}
                                                        selected={
                                                            cond.value
                                                                ? { value: cond.value, label: cond.value }
                                                                : null
                                                        }
                                                        setSelected={(o) => {
                                                            const next = [...form.conditions];
                                                            next[i] = { ...next[i], value: o?.value ?? '' };
                                                            patch({ conditions: next });
                                                        }}
                                                        placeholder={t('ruleBuilder.valuePlaceholder')}
                                                        matchTriggerWidth
                                                    />
                                                ) : (
                                                    <Input
                                                        type={
                                                            fieldDef?.type === 'number' && !isSet
                                                                ? 'number'
                                                                : 'text'
                                                        }
                                                        value={cond.value}
                                                        onChange={(e) => {
                                                            const next = [...form.conditions];
                                                            next[i] = { ...next[i], value: e.target.value };
                                                            patch({ conditions: next });
                                                        }}
                                                        placeholder={isSet ? t('ruleBuilder.csvPlaceholder') : t('ruleBuilder.value')}
                                                    />
                                                )}
                                            </FormField>
                                            <Button
                                                variant="ghost"
                                                onClick={() =>
                                                    patch({
                                                        conditions: form.conditions.filter((_, j) => j !== i),
                                                    })
                                                }
                                                aria-label={t('ruleBuilder.removeCondition')}
                                            >
                                                {t('ruleBuilder.remove')}
                                            </Button>
                                        </div>
                                    );
                                })}
                                <Button
                                    variant="secondary"
                                    onClick={() =>
                                        patch({
                                            conditions: [
                                                ...form.conditions,
                                                {
                                                    field: availableFields[0]?.field ?? '',
                                                    operator: 'eq',
                                                    value: '',
                                                },
                                            ],
                                        })
                                    }
                                >
                                    {t('ruleBuilder.addCondition')}
                                </Button>
                                <p className="text-xs text-content-subtle">
                                    {t('ruleBuilder.setOperatorsHint')}
                                </p>
                            </>
                        )}
                    </div>
                )}

                {step === 3 && (
                    <div className="space-y-default">
                        <RadioGroup
                            value={form.actionType}
                            onValueChange={(v) => patch({ actionType: v as ActionType })}
                            className="space-y-tight"
                        >
                            {actionOptions.map((a) => (
                                <label key={a.value} className="flex items-center gap-compact text-sm">
                                    <RadioGroupItem value={a.value} />
                                    <span className="text-content-emphasis">{a.label}</span>
                                    <span className="text-content-subtle">— {a.hint}</span>
                                </label>
                            ))}
                        </RadioGroup>

                        <div className="border-t border-border-subtle pt-default space-y-default">
                            {form.actionType === 'NOTIFY_USER' && (
                                <>
                                    <FormField label={t('ruleBuilder.recipients')} required>
                                        <UserCombobox
                                            tenantSlug={tenantSlug}
                                            multiple
                                            selectedIds={form.notify.userIds}
                                            onChange={(ids) =>
                                                patch({ notify: { ...form.notify, userIds: ids } })
                                            }
                                            matchTriggerWidth
                                        />
                                    </FormField>
                                    <FormField label={t('ruleBuilder.message')} required>
                                        <Textarea
                                            value={form.notify.message}
                                            onChange={(e) =>
                                                patch({ notify: { ...form.notify, message: e.target.value } })
                                            }
                                            placeholder={t('ruleBuilder.messagePlaceholder')}
                                        />
                                    </FormField>
                                </>
                            )}
                            {form.actionType === 'CREATE_TASK' && (
                                <FormField label={t('ruleBuilder.taskTitle')} required>
                                    <Input
                                        value={form.task.title}
                                        onChange={(e) =>
                                            patch({ task: { ...form.task, title: e.target.value } })
                                        }
                                        placeholder={t('ruleBuilder.taskTitlePlaceholder')}
                                    />
                                </FormField>
                            )}
                            {form.actionType === 'UPDATE_STATUS' && (
                                <FormField label={t('ruleBuilder.newStatus')} required>
                                    <Input
                                        value={form.status.toStatus}
                                        onChange={(e) =>
                                            patch({ status: { ...form.status, toStatus: e.target.value } })
                                        }
                                        placeholder="IN_REVIEW"
                                    />
                                </FormField>
                            )}
                            {form.actionType === 'WEBHOOK' && (
                                <FormField label={t('ruleBuilder.webhookUrl')} required>
                                    <Input
                                        value={form.webhook.url}
                                        onChange={(e) =>
                                            patch({ webhook: { ...form.webhook, url: e.target.value } })
                                        }
                                        placeholder="https://hooks.example.com/…"
                                    />
                                </FormField>
                            )}
                        </div>

                        {/* SLA window (Epic 5) — optional deadline for resolution. */}
                        <div className="border-t border-border-subtle pt-default">
                            <FormField
                                label={t('automationInspector.slaWindow')}
                                description={t('ruleBuilder.slaDescription')}
                            >
                                <Input
                                    type="number"
                                    min={1}
                                    value={form.slaWindowMinutes}
                                    onChange={(e) => patch({ slaWindowMinutes: e.target.value })}
                                    placeholder={t('ruleBuilder.slaPlaceholder')}
                                />
                            </FormField>
                        </div>

                        {/* Chain to next rule (Epic 7) — sequential workflow. */}
                        <div className="border-t border-border-subtle pt-default space-y-default">
                            <FormField
                                label={t('ruleBuilder.chainToNext')}
                                description={t('ruleBuilder.chainDescription')}
                            >
                                <Combobox
                                    options={chainOptions}
                                    selected={
                                        form.nextRuleId
                                            ? chainOptions.find((o) => o.value === form.nextRuleId) ?? null
                                            : null
                                    }
                                    setSelected={(o) => patch({ nextRuleId: o?.value ?? '' })}
                                    placeholder={t('ruleBuilder.noChainedRule')}
                                    matchTriggerWidth
                                />
                            </FormField>
                            {form.nextRuleId && (
                                <FormField label={t('ruleBuilder.chainDelay')}>
                                    <Input
                                        type="number"
                                        min={0}
                                        value={form.nextRuleDelay}
                                        onChange={(e) => patch({ nextRuleDelay: e.target.value })}
                                        placeholder={t('ruleBuilder.chainDelayPlaceholder')}
                                    />
                                </FormField>
                            )}
                        </div>
                    </div>
                )}

                {error && <p className="mt-default text-sm text-content-error">{error}</p>}
            </Modal.Body>
            <Modal.Actions align="between">
                <Button
                    variant="ghost"
                    onClick={() => (step === 1 ? setOpen(false) : setStep((s) => (s - 1) as 1 | 2))}
                >
                    {step === 1 ? tCommon('cancel') : tCommon('back')}
                </Button>
                {step < 3 ? (
                    <Button
                        variant="primary"
                        disabled={step === 1 && !step1Valid}
                        onClick={() => setStep((s) => (s + 1) as 2 | 3)}
                    >
                        {t('ruleBuilder.next')}
                    </Button>
                ) : (
                    <Button
                        variant="primary"
                        loading={submitting}
                        disabled={!step3Valid || submitting}
                        onClick={handleSave}
                    >
                        {editRule ? t('ruleBuilder.saveRule') : t('ruleBuilder.createRule')}
                    </Button>
                )}
            </Modal.Actions>
        </Modal>
    );
}
