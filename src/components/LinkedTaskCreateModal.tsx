'use client';

/**
 * LinkedTaskCreateModal — shared create-task modal used by the
 * Asset detail page's Tasks tab (via LinkedTasksPanel).
 *
 * Mirrors `NewControlTaskModal` (the Control detail page's modal)
 * with one key difference: the Control flow has a dedicated
 * `POST /controls/<id>/tasks` endpoint that auto-links the task,
 * while ASSET doesn't. This modal therefore does TWO calls
 * sequentially on submit:
 *
 *   1. `POST /tasks` (generic create) — body matches
 *      `CreateTaskSchema`.
 *   2. `POST /tasks/<id>/links` — body matches `AddTaskLinkSchema`
 *      with `{ entityType, entityId, relation: 'RELATES_TO' }`.
 *
 * If step 2 fails the orphan task is left in place (the user can
 * still link it manually from the task detail page). A future
 * follow-up could wrap both calls in a server-side compound
 * endpoint; the two-call shape is the smallest blast-radius
 * implementation today.
 *
 * Why a sibling module of LinkedTasksPanel (not nested in
 * `_modals/` like Control's): the panel is shared across consumer
 * pages, so the modal lives alongside it in `src/components/` for
 * shared visibility.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import { FormField } from '@/components/ui/form-field';
import { Modal } from '@/components/ui/modal';
import {
    parseYMD,
    startOfUtcDay,
    toYMD,
} from '@/components/ui/date-picker/date-utils';

export type LinkedTaskEntityType = 'ASSET';

export interface LinkedTaskCreateModalProps {
    open: boolean;
    setOpen: (next: boolean) => void;
    /** Base URL prefix for /tasks + /tasks/{id}/links — typically `apiUrl('')`. */
    apiBase: string;
    /** Which domain entity to link the new task to. */
    entityType: LinkedTaskEntityType;
    /** The id of the entity (asset id). */
    entityId: string;
    /** Called after both calls succeed so the panel can refetch its list. */
    onCreated: () => void;
}

export function LinkedTaskCreateModal({
    open,
    setOpen,
    apiBase,
    entityType,
    entityId,
    onCreated,
}: LinkedTaskCreateModalProps) {
    const t = useTranslations('linkedTask');
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [dueAt, setDueAt] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const reset = () => {
        setTitle('');
        setDescription('');
        setDueAt('');
        setError(null);
    };

    const handleCancel = () => {
        if (saving) return;
        reset();
        setOpen(false);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (saving) return;
        setSaving(true);
        setError(null);
        try {
            // Step 1 — create the task itself. The generic /tasks
            // POST doesn't carry the entity link in its schema; we
            // do that via the dedicated /links endpoint below.
            const createRes = await fetch(`${apiBase}/tasks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title,
                    description: description || undefined,
                    dueAt: dueAt || undefined,
                }),
            });
            if (!createRes.ok) {
                throw new Error(`Create task failed (${createRes.status})`);
            }
            const task = (await createRes.json()) as { id: string };

            // Step 2 — link the new task to the asset / risk. If
            // this fails the user sees a clear error and the task
            // exists on the global Tasks list, so no data is lost.
            const linkRes = await fetch(
                `${apiBase}/tasks/${encodeURIComponent(task.id)}/links`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        entityType,
                        entityId,
                        relation: 'RELATES_TO',
                    }),
                },
            );
            if (!linkRes.ok) {
                throw new Error(
                    `Task created but linking failed (${linkRes.status}). Open the task to link it manually.`,
                );
            }

            reset();
            setOpen(false);
            onCreated();
        } catch (err) {
            setError(
                err instanceof Error ? err.message : 'Could not create task',
            );
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal
            showModal={open}
            setShowModal={(v) => {
                const next = typeof v === 'function' ? v(open) : v;
                if (!next && !saving) handleCancel();
                else setOpen(next);
            }}
            size="md"
            title={t('createTask')}
            description={t('descriptionAsset')}
            preventDefaultClose={saving}
        >
            <Modal.Header
                title={t('createTask')}
                description={t('descriptionAsset')}
            />
            <Modal.Form
                onSubmit={handleSubmit}
                id="linked-task-create-dialog"
                data-testid="linked-task-create-dialog"
            >
                <Modal.Body>
                    {error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            role="alert"
                            data-testid="linked-task-create-error"
                        >
                            {error}
                        </div>
                    )}
                    <fieldset className="space-y-default" disabled={saving}>
                        <FormField label={t('title')} required>
                            <input
                                id="linked-task-title-input"
                                type="text"
                                className="input w-full"
                                placeholder={t('titlePlaceholder')}
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                required
                                minLength={1}
                                autoFocus
                                data-testid="linked-task-title-input"
                            />
                        </FormField>
                        <FormField label={t('description')}>
                            <textarea
                                id="linked-task-desc-input"
                                className="input w-full"
                                rows={3}
                                placeholder={t('descriptionPlaceholder')}
                                value={description}
                                onChange={(e) =>
                                    setDescription(e.target.value)
                                }
                                data-testid="linked-task-desc-input"
                            />
                        </FormField>
                        <FormField label={t('dueDate')}>
                            <DatePicker
                                id="linked-task-due-input"
                                className="w-full"
                                placeholder={t('dueDatePlaceholder')}
                                clearable
                                align="start"
                                value={parseYMD(dueAt)}
                                onChange={(next) =>
                                    setDueAt(toYMD(next) ?? '')
                                }
                                disabledDays={{
                                    before: startOfUtcDay(new Date()),
                                }}
                                aria-label={t('dueDateAria')}
                            />
                        </FormField>
                    </fieldset>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleCancel}
                        disabled={saving}
                        data-testid="linked-task-cancel-button"
                    >
                        {t('cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        disabled={saving || title.trim().length === 0}
                        id="linked-task-submit-btn"
                        data-testid="linked-task-submit-btn"
                    >
                        {saving ? t('creating') : t('create')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
