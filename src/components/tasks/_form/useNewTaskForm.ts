'use client';

/**
 * Task-create form hook — B6 useZodForm adoption.
 *
 * Pre-B6 this was a hand-rolled `useState` shape. B6 ports the
 * core form-state onto `useZodForm` (driven by
 * `NewTaskFormSchema`). The TASK-specific extras stay outside the
 * Zod schema:
 *
 *   - `pendingLinks` — staging buffer for secondary POSTs after
 *     the task is minted. Not part of the canonical task body so
 *     it stays in local state.
 *   - `validationMessage` — retained as a constant empty string. It
 *     was a derived semantic gate for three task types that the GRC
 *     teardown removed (operator decision A6), and `canSubmit` still
 *     ANDs it in, so the contract with `<NewTaskFields>` is unchanged.
 *
 * The `findingSource` / `practiceGapType` extras — and with them the
 * mixed-keyset setField/touchField/fieldError bridge that existed purely
 * to carry non-Zod fields — went with those task types.
 */
import { useState } from 'react';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useFormTelemetry } from '@/lib/telemetry/form-telemetry';
import { useZodForm } from '@/lib/hooks/use-zod-form';
import {
    NewTaskFormSchema,
    type NewTaskFormValues,
} from '@/lib/schemas/task-form';

export type TaskType = NewTaskFormValues['type'];

export interface PendingLink {
    entityType: string;
    entityId: string;
}

export type NewTaskFormFields = NewTaskFormValues;

export interface NewTaskFormReturn {
    fields: NewTaskFormFields;
    setField: <K extends keyof NewTaskFormFields>(
        key: K,
        value: NewTaskFormFields[K],
    ) => void;
    touchField: <K extends keyof NewTaskFormFields>(key: K) => void;
    fieldError: <K extends keyof NewTaskFormFields>(key: K) => string | undefined;
    pendingLinks: PendingLink[];
    linkEntityType: string;
    setLinkEntityType: (entityType: string) => void;
    linkEntityId: string;
    setLinkEntityId: (entityId: string) => void;
    addPendingLink: () => void;
    removePendingLink: (index: number) => void;
    submitting: boolean;
    error: string | null;
    canSubmit: boolean;
    validationMessage: string;
    submit: () => Promise<void>;
    isDirty: boolean;
}

export interface UseNewTaskFormOptions {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onSuccess: (task: any) => void;
    /**
     * PR-C — optional pre-fill for the `dueAt` field. The calendar
     * page double-click flow seeds this with the day cell's YMD so
     * the create modal opens with the right due date already
     * selected.
     */
    initialDueAt?: string;
    /**
     * Preset entity links staged on open. The practice / asset / risk
     * detail pages seed this with their own entity so a task created
     * from those surfaces is linked back (and lands in the global
     * Tasks list) without the user having to add the link by hand.
     */
    initialPendingLinks?: PendingLink[];
}

const INITIAL: NewTaskFormValues = {
    title: '',
    description: '',
    type: 'TASK',
    severity: 'MEDIUM',
    priority: 'P2',
    dueAt: '',
    assigneeUserId: '',
    reviewerUserId: '',
};

export function useNewTaskForm({
    onSuccess,
    initialDueAt,
    initialPendingLinks,
}: UseNewTaskFormOptions): NewTaskFormReturn {
    const apiUrl = useTenantApiUrl();
    const telemetry = useFormTelemetry('NewTaskPage');

    // Extras kept outside Zod — see file header.
    const [pendingLinks, setPendingLinks] = useState<PendingLink[]>(
        initialPendingLinks ?? [],
    );
    // `pendingLinks` lives outside the Zod form, so `zod.isDirty` cannot
    // see it. This was `extrasDirty` and also covered the findingSource /
    // practiceGapType extras; those went with the GRC teardown, the links
    // did not.
    const [linksDirty, setLinksDirty] = useState(false);
    const [linkEntityType, setLinkEntityType] = useState('ASSET');
    const [linkEntityId, setLinkEntityId] = useState('');

    const zod = useZodForm({
        schema: NewTaskFormSchema,
        // PR-C — merge any caller-supplied seed (currently just the
        // calendar's double-click date) over the canonical INITIAL.
        initial: initialDueAt
            ? { ...INITIAL, dueAt: initialDueAt }
            : INITIAL,
        onSubmit: async (payload) => {
            telemetry.trackSubmit({
                type: payload.type,
                severity: payload.severity,
                priority: payload.priority,
                pendingLinkCount: pendingLinks.length,
                hasAssignee: Boolean(payload.assigneeUserId),
            });

            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const body: any = {
                    title: payload.title,
                    type: payload.type,
                    severity: payload.severity,
                    priority: payload.priority,
                    description: payload.description || undefined,
                    dueAt: payload.dueAt || undefined,
                    assigneeUserId: payload.assigneeUserId || undefined,
                };
                const res = await fetch(apiUrl('/tasks'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    const msg =
                        typeof data.error === 'string'
                            ? data.error
                            : data.message || 'Failed to create task';
                    throw new Error(msg);
                }
                const task = await res.json();

                // Best-effort secondary POSTs for the staged links.
                for (const link of pendingLinks) {
                    await fetch(apiUrl(`/tasks/${task.id}/links`), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            entityType: link.entityType,
                            entityId: link.entityId,
                            relation: 'RELATES_TO',
                        }),
                    }).catch(() => {
                        /* swallow — link is best-effort */
                    });
                }

                telemetry.trackSuccess({ taskId: task.id });
                onSuccess(task);
            } catch (e) {
                // Re-throw so useZodForm marks the hook's `error`
                // state; telemetry sink gets the same instance.
                telemetry.trackError(e);
                throw e;
            }
        },
    });

    // Every field is Zod-managed now that the extras are gone, so these
    // delegate straight through.
    const setField: NewTaskFormReturn['setField'] = (key, value) => {
        zod.setField(key, value);
    };

    const touchField: NewTaskFormReturn['touchField'] = (key) => {
        zod.touchField(key);
    };

    const fieldError: NewTaskFormReturn['fieldError'] = (key) => zod.fieldError(key);

    const fields: NewTaskFormFields = { ...zod.values };

    const addPendingLink = () => {
        if (!linkEntityId.trim()) return;
        setPendingLinks((prev) => [
            ...prev,
            { entityType: linkEntityType, entityId: linkEntityId.trim() },
        ]);
        setLinkEntityId('');
        setLinksDirty(true);
    };
    const removePendingLink = (idx: number) => {
        setPendingLinks((prev) => prev.filter((_, i) => i !== idx));
    };

    // GRC teardown phase 2 (operator decision A6). The cross-field
    // validation here existed for three task types that are gone:
    // AUDIT_FINDING / PRACTICE_GAP required a practice or
    // framework-requirement link, INCIDENT required an asset or practice.
    // Both Practice and FrameworkRequirement are KILL models, so neither
    // rule has a subject. TASK and IMPROVEMENT never carried a
    // type-conditional requirement, which is why this collapses to a
    // constant rather than shrinking.
    const validationMessage = '';

    return {
        fields,
        setField,
        touchField,
        fieldError,
        pendingLinks,
        linkEntityType,
        setLinkEntityType,
        linkEntityId,
        setLinkEntityId,
        addPendingLink,
        removePendingLink,
        submitting: zod.submitting,
        error: zod.error,
        canSubmit: zod.canSubmit && !validationMessage,
        validationMessage,
        submit: async () => {
            if (validationMessage) {
                // Surface the semantic-gate message so the consumer
                // doesn't need a separate guard before calling submit.
                throw new Error(validationMessage);
            }
            await zod.submit();
        },
        isDirty: zod.isDirty || linksDirty,
    };
}
