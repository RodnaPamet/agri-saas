'use client';

/**
 * Controlled field markup for the task-create form. Reads its state
 * from a `useNewTaskForm()` instance — owns no state of its own.
 *
 * Both the legacy `/tasks/new` page and the future `<NewTaskModal>`
 * (P2) compose this component unchanged.
 */
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { FormError } from '@/components/ui/form-error';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip } from '@/components/ui/tooltip';
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import {
    parseYMD,
    startOfUtcDay,
    toYMD,
} from '@/components/ui/date-picker/date-utils';
import { UserCombobox } from '@/components/ui/user-combobox';
import {
    EntityPicker,
    type EntityPickerKind,
} from '@/components/ui/entity-picker';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { useTranslations } from 'next-intl';
import type { NewTaskFormFields, NewTaskFormReturn } from './useNewTaskForm';

const TYPE_OPTIONS: ComboboxOption[] = [
    { value: 'TASK', label: 'Task' },
    { value: 'AUDIT_FINDING', label: 'Audit Finding' },
    { value: 'CONTROL_GAP', label: 'Control Gap' },
    { value: 'INCIDENT', label: 'Incident' },
    { value: 'IMPROVEMENT', label: 'Improvement' },
];
const SEVERITY_OPTIONS: ComboboxOption[] = [
    { value: 'INFO', label: 'Info' },
    { value: 'LOW', label: 'Low' },
    { value: 'MEDIUM', label: 'Medium' },
    { value: 'HIGH', label: 'High' },
    { value: 'CRITICAL', label: 'Critical' },
];
const PRIORITY_OPTIONS: ComboboxOption[] = [
    { value: 'P0', label: 'P0 — Critical' },
    { value: 'P1', label: 'P1 — High' },
    { value: 'P2', label: 'P2 — Medium' },
    { value: 'P3', label: 'P3 — Low' },
];
const LINK_ENTITY_OPTIONS: ComboboxOption[] = [
    { value: 'CONTROL', label: 'Control' },
    { value: 'FRAMEWORK_REQUIREMENT', label: 'Framework Requirement' },
    { value: 'ASSET', label: 'Asset' },
    { value: 'RISK', label: 'Risk' },
    { value: 'EVIDENCE', label: 'Evidence' },
];
const FINDING_OPTIONS: ComboboxOption[] = [
    { value: 'INTERNAL', label: 'Internal' },
    { value: 'EXTERNAL_AUDITOR', label: 'External Auditor' },
    { value: 'PEN_TEST', label: 'Pen Test' },
    { value: 'INCIDENT', label: 'Incident' },
];
const GAP_TYPE_OPTIONS: ComboboxOption[] = [
    { value: 'DESIGN', label: 'Design' },
    { value: 'OPERATING_EFFECTIVENESS', label: 'Operating Effectiveness' },
    { value: 'DOCUMENTATION', label: 'Documentation' },
];

export function NewTaskFields({
    form,
    tenantSlug,
}: {
    form: NewTaskFormReturn;
    tenantSlug: string;
}) {
    const t = useTranslations('tasks.newFields');
    return (
        <>
            <FormField label={t('title')} required>
                <Input
                    id="task-title-input"
                    type="text"
                    placeholder={t('titlePlaceholder')}
                    value={form.fields.title}
                    onChange={(e) => form.setField('title', e.target.value)}
                    required
                />
            </FormField>
            <FormField label={t('description')}>
                <Textarea
                    id="task-description-input"
                    rows={3}
                    placeholder={t('descriptionPlaceholder')}
                    value={form.fields.description}
                    onChange={(e) => form.setField('description', e.target.value)}
                />
            </FormField>
            <div className="grid grid-cols-3 gap-default">
                <FormField label={t('type')} required>
                    <Combobox
                        id="task-type-select"
                        name="type"
                        options={TYPE_OPTIONS}
                        selected={
                            TYPE_OPTIONS.find(
                                (o) => o.value === form.fields.type,
                            ) ?? null
                        }
                        setSelected={(o) =>
                            form.setField(
                                'type',
                                (o?.value ?? 'TASK') as typeof form.fields.type,
                            )
                        }
                        placeholder={t('typePlaceholder')}
                        hideSearch
                        matchTriggerWidth
                        buttonProps={{ className: 'w-full' }}
                        caret
                    />
                </FormField>
                <FormField label={t('severity')}>
                    <Combobox
                        id="task-severity-select"
                        name="severity"
                        options={SEVERITY_OPTIONS}
                        selected={
                            SEVERITY_OPTIONS.find(
                                (o) => o.value === form.fields.severity,
                            ) ?? null
                        }
                        setSelected={(o) =>
                            form.setField(
                                'severity',
                                (o?.value ?? 'MEDIUM') as NewTaskFormFields['severity'],
                            )
                        }
                        placeholder={t('severityPlaceholder')}
                        hideSearch
                        matchTriggerWidth
                        buttonProps={{ className: 'w-full' }}
                        caret
                    />
                </FormField>
                <FormField label={t('priority')}>
                    <Combobox
                        id="task-priority-select"
                        name="priority"
                        options={PRIORITY_OPTIONS}
                        selected={
                            PRIORITY_OPTIONS.find(
                                (o) => o.value === form.fields.priority,
                            ) ?? null
                        }
                        setSelected={(o) =>
                            form.setField(
                                'priority',
                                (o?.value ?? 'P2') as NewTaskFormFields['priority'],
                            )
                        }
                        placeholder={t('priorityPlaceholder')}
                        hideSearch
                        matchTriggerWidth
                        buttonProps={{ className: 'w-full' }}
                        caret
                    />
                </FormField>
            </div>
            <div className="grid grid-cols-2 gap-default">
                <FormField label={t('dueDate')}>
                    <DatePicker
                        id="task-due-input"
                        className="w-full"
                        placeholder={t('datePlaceholder')}
                        clearable
                        align="start"
                        value={parseYMD(form.fields.dueAt)}
                        onChange={(next) =>
                            form.setField('dueAt', toYMD(next) ?? '')
                        }
                        disabledDays={{
                            before: startOfUtcDay(new Date()),
                        }}
                        aria-label={t('dueDateAria')}
                    />
                </FormField>
                <FormField label={t('assignee')}>
                    <UserCombobox
                        id="task-assignee-input"
                        name="assigneeUserId"
                        tenantSlug={tenantSlug}
                        selectedId={form.fields.assigneeUserId || null}
                        onChange={(userId) =>
                            form.setField('assigneeUserId', userId ?? '')
                        }
                        placeholder={t('unassigned')}
                        forceDropdown={false}
                    />
                </FormField>
            </div>

            <FormField label={t('control')}>
                <EntityPicker
                    id="task-control-input"
                    tenantSlug={tenantSlug}
                    entityType="CONTROL"
                    value={form.fields.controlId ?? ''}
                    onChange={(id) => form.setField('controlId', id)}
                    placeholder={t('controlPlaceholder')}
                    testId="task-control-picker"
                />
            </FormField>

            {(form.fields.type === 'AUDIT_FINDING' ||
                form.fields.type === 'CONTROL_GAP') && (
                <div className="border-t border-border-default pt-4 space-y-default">
                    <Heading level={3}>{t('auditDetails')}</Heading>
                    <div className="grid grid-cols-2 gap-default">
                        <FormField label={t('findingSource')}>
                            <Combobox
                                id="finding-source-select"
                                name="findingSource"
                                options={FINDING_OPTIONS}
                                selected={
                                    FINDING_OPTIONS.find(
                                        (o) =>
                                            o.value === form.fields.findingSource,
                                    ) ?? null
                                }
                                setSelected={(o) =>
                                    form.setField('findingSource', o?.value ?? '')
                                }
                                placeholder={t('findingSourcePlaceholder')}
                                hideSearch
                                matchTriggerWidth
                                buttonProps={{ className: 'w-full' }}
                                caret
                            />
                        </FormField>
                        {form.fields.type === 'CONTROL_GAP' && (
                            <FormField label={t('controlGapType')}>
                                <Combobox
                                    id="gap-type-select"
                                    name="controlGapType"
                                    options={GAP_TYPE_OPTIONS}
                                    selected={
                                        GAP_TYPE_OPTIONS.find(
                                            (o) =>
                                                o.value ===
                                                form.fields.controlGapType,
                                        ) ?? null
                                    }
                                    setSelected={(o) =>
                                        form.setField(
                                            'controlGapType',
                                            o?.value ?? '',
                                        )
                                    }
                                    placeholder={t('controlGapTypePlaceholder')}
                                    hideSearch
                                    matchTriggerWidth
                                    buttonProps={{ className: 'w-full' }}
                                    caret
                                />
                            </FormField>
                        )}
                    </div>
                </div>
            )}

            {/* Links section */}
            <div className="border-t border-border-default pt-4 space-y-compact">
                <Heading level={3}>{t('links')}</Heading>
                {form.validationMessage && (
                    <FormError
                        id="link-validation-hint"
                        className="bg-bg-warning/10 border border-border-warning/40 text-content-warning rounded px-3 py-2 mt-0"
                    >
                        {form.validationMessage}
                    </FormError>
                )}
                <div className="flex gap-tight items-end">
                    <FormField label={t('entityType')} className="flex-1">
                        <Combobox
                            id="link-entity-type"
                            name="linkEntityType"
                            options={LINK_ENTITY_OPTIONS}
                            selected={
                                LINK_ENTITY_OPTIONS.find(
                                    (o) => o.value === form.linkEntityType,
                                ) ?? null
                            }
                            setSelected={(o) =>
                                form.setLinkEntityType(o?.value ?? 'CONTROL')
                            }
                            placeholder={t('entityTypePlaceholder')}
                            hideSearch
                            matchTriggerWidth
                            buttonProps={{ className: 'w-full' }}
                            caret
                        />
                    </FormField>
                    <FormField label={t('entity')} className="flex-1">
                        {/* PR-D — entity picker replaces the legacy
                            "Paste ID" Input. Driven by the sibling
                            entity-type Combobox above; the picker
                            writes the cuid into `form.linkEntityId`
                            so the addPendingLink handler stays
                            unchanged. */}
                        <EntityPicker
                            tenantSlug={tenantSlug}
                            entityType={form.linkEntityType as EntityPickerKind}
                            value={form.linkEntityId}
                            onChange={form.setLinkEntityId}
                            id="link-entity-id"
                            testId="new-task-link-entity-picker"
                            placeholder={t('entityPlaceholder')}
                        />
                    </FormField>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={form.addPendingLink}
                        id="add-link-btn"
                    >
                        {t('add')}
                    </Button>
                </div>
                {form.pendingLinks.length > 0 && (
                    <div className="space-y-1" id="pending-links-list">
                        {form.pendingLinks.map((l, i) => (
                            <div
                                key={i}
                                className="flex items-center gap-tight text-sm text-content-default bg-bg-default/50 rounded px-3 py-1.5"
                            >
                                <StatusBadge variant="info">
                                    {l.entityType}
                                </StatusBadge>
                                <span className="font-mono text-xs flex-1">
                                    {l.entityId}
                                </span>
                                <Tooltip content={t('removeLinkedItem')}>
                                    <button
                                        type="button"
                                        className="text-content-error text-xs hover:text-content-error"
                                        onClick={() => form.removePendingLink(i)}
                                        aria-label={t('removeLink')}
                                    >
                                        ×
                                    </button>
                                </Tooltip>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </>
    );
}
