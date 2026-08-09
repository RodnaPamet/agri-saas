'use client';

/**
 * NewTaskModal — modal-form P2 execution.
 *
 * Mounts the P1-extracted `useNewTaskForm` hook + `<NewTaskFields>`
 * markup inside `<Modal>`. The hook owns the pending-links staging
 * buffer + the per-type validation (`AUDIT_FINDING` / `PRACTICE_GAP`
 * requires a practice or link); the modal just chrome's it.
 *
 * Shared create-task modal, consumed by the calendar and the Epic-67
 * LinkedTasksPanel. The compliance /tasks list was retired; the default
 * post-create destination is the single task detail at /farm-tasks/[taskId].
 */
import { type Dispatch, type SetStateAction } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTenantHref, useTenantContext } from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { useNewTaskForm, type PendingLink } from './_form/useNewTaskForm';
import { NewTaskFields } from './_form/NewTaskFields';

export interface NewTaskModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    /**
     * PR-C — optional pre-fill for the `dueAt` field. The calendar
     * page double-click flow seeds this with the clicked day's YMD.
     * When omitted the modal opens in its canonical empty state.
     */
    initialDueAt?: string;
    /**
     * PR-C — optional override for the post-create destination. The
     * default behaviour pushes the user to the new task's detail
     * page; the calendar page passes a no-op so the calendar view
     * stays in place after the task lands.
     */
    onCreated?: () => void;
    /**
     * Preset entity links staged on open. The practice / asset / risk
     * detail surfaces seed this with their own entity so the task is
     * linked back (and shows in their tasks panel) on create.
     */
    initialPendingLinks?: PendingLink[];
}

export function NewTaskModal({
    open,
    setOpen,
    initialDueAt,
    onCreated,
    initialPendingLinks,
}: NewTaskModalProps) {
    const tenantHref = useTenantHref();
    const { tenantSlug } = useTenantContext();
    const router = useRouter();
    const t = useTranslations('tasks.newModal');

    const form = useNewTaskForm({
        onSuccess: (task) => {
            setOpen(false);
            if (onCreated) {
                onCreated();
            } else {
                router.push(tenantHref(`/farm-tasks/${task.id}`));
            }
        },
        initialDueAt,
        initialPendingLinks,
    });

    // P3 — unsaved-changes guard. The Modal primitive's `isDirty` prop
    // renders a native "Discard changes?" confirm on any stray dismiss
    // (drag-down / backdrop / Escape); the explicit Cancel button calls
    // `setOpen(false)` directly to bypass it.
    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        void form.submit();
    };

    return (
        <Modal
            showModal={open}
            setShowModal={setOpen}
            size="lg"
            title={t('title')}
            description={t('description')}
            preventDefaultClose={form.submitting}
            isDirty={form.isDirty}
        >
            <Modal.Header
                title={t('title')}
                description={t('description')}
            />
            <Modal.Form id="new-task-form" onSubmit={handleSubmit}>
                <Modal.Body>
                    {form.error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="new-task-error"
                            role="alert"
                        >
                            {form.error}
                        </div>
                    )}
                    <fieldset
                        disabled={form.submitting}
                        className="m-0 p-0 border-0 space-y-default"
                    >
                        <NewTaskFields form={form} tenantSlug={tenantSlug} />
                    </fieldset>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setOpen(false)}
                        disabled={form.submitting}
                        id="new-task-cancel-btn"
                    >
                        {t('cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        disabled={!form.canSubmit}
                        id="create-task-btn"
                    >
                        {form.submitting ? t('creating') : t('create')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
