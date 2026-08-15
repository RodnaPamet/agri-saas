'use client';

/**
 * Controlled field markup for the task-create form. Reads its state
 * from a `useNewTaskForm()` instance — owns no state of its own.
 *
 * Both the legacy `/tasks/new` page and the future `<NewTaskModal>`
 * (P2) compose this component unchanged.
 */
import { z } from 'zod';
import { AddTaskLinkSchema } from '@/lib/schemas';
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

// GRC teardown phase 2 (operator decision A6): Audit Finding, Practice Gap
// and Incident removed — each required a practice link, and Practice is a
// KILL model.
const TYPE_OPTIONS: ComboboxOption[] = [
    { value: 'TASK', label: 'Task' },
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
// DERIVED from the schema the API actually validates against, not
// hand-listed. The literal version offered PRACTICE and
// FRAMEWORK_REQUIREMENT — both removed from AddTaskLinkSchema with their
// models — and DEFAULTED to PRACTICE, so adding a link with the default
// selection 400'd on `schema.parse`. `Record<…, string>` gives
// compile-time totality: a member added to the zod enum fails to build
// here until it has a label.
const LINK_ENTITY_LABELS: Record<
    z.infer<typeof AddTaskLinkSchema>['entityType'],
    string
> = {
    ASSET: 'Asset',
    EVIDENCE: 'Evidence',
    FILE: 'File',
    LOCATION: 'Location',
    PARCEL: 'Parcel',
    EQUIPMENT: 'Equipment',
    PLANTING: 'Planting',
};
const LINK_ENTITY_OPTIONS: ComboboxOption[] =
    AddTaskLinkSchema.shape.entityType.options.map((value) => ({
        value,
        label: LINK_ENTITY_LABELS[value],
    }));

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
                                form.setLinkEntityType(o?.value ?? 'ASSET')
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
