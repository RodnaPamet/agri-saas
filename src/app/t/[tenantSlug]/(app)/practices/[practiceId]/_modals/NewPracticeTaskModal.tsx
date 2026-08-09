/**
 * Practice detail page — Tasks tab — "+ Task" affordance migrates
 * from an inline `<form>` to a modal. Matches the EditPracticeModal
 * extraction pattern: the page still owns state + mutation, the
 * modal is a thin presentational renderer that takes everything
 * via props.
 *
 * Before: clicking "+ Task" toggled an in-page card with the form
 * fields right above the Tasks DataTable. That broke the visual
 * model — the user was already in the Tasks tab, but the form sat
 * outside the table chrome and competed with the rows for attention.
 *
 * After: the click opens a modal. The Tasks tab stays at rest;
 * the user fills out the modal, hits Create, the modal closes,
 * the table refreshes with the new row. Matches the canonical
 * "create-flow as modal" pattern documented in
 * `docs/modal-sheet-strategy.md`.
 *
 * Why a sibling module under `_modals/`:
 *   The parent page is already 1200+ lines and Next.js skips
 *   `_<dirname>/` so it doesn't treat the file as a route. Same
 *   pattern as EditPracticeModal — keep extractions adjacent to
 *   the page they came from.
 */
'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import { FormField } from '@/components/ui/form-field';
import { Modal } from '@/components/ui/modal';
import { parseYMD, startOfUtcDay, toYMD } from '@/components/ui/date-picker/date-utils';

export interface NewPracticeTaskModalProps {
    open: boolean;
    setOpen: (next: boolean) => void;
    /** Bound to the page's task-title state. */
    title: string;
    setTitle: (next: string) => void;
    /** Bound to the page's task-description state. */
    description: string;
    setDescription: (next: string) => void;
    /** YYYY-MM-DD or empty string. */
    dueAt: string;
    setDueAt: (next: string) => void;
    /** True while the POST is in flight. Disables fields + submit. */
    saving: boolean;
    /** Submit handler. Owns the POST + refetch + close. */
    onSubmit: (e: React.FormEvent) => void | Promise<void>;
    /** Cancel handler. Resets fields + closes (caller's choice). */
    onCancel: () => void;
}

export function NewPracticeTaskModal({
    open,
    setOpen,
    title,
    setTitle,
    description,
    setDescription,
    dueAt,
    setDueAt,
    saving,
    onSubmit,
    onCancel,
}: NewPracticeTaskModalProps) {
    const t = useTranslations('practices');
    return (
        <Modal
            showModal={open}
            setShowModal={(v) => {
                const next = typeof v === 'function' ? v(open) : v;
                if (!next && !saving) onCancel();
                else setOpen(next);
            }}
            size="md"
            title={t('taskModal.title')}
            description={t('taskModal.description')}
            preventDefaultClose={saving}
        >
            <Modal.Header
                title={t('taskModal.title')}
                description={t('taskModal.description')}
            />
            <Modal.Form
                onSubmit={onSubmit}
                id="practice-task-create-dialog"
                data-testid="practice-task-create-dialog"
            >
                <Modal.Body>
                    <fieldset className="space-y-default" disabled={saving}>
                        <FormField label={t('taskModal.titleField')} required>
                            <input
                                id="task-title-input"
                                type="text"
                                className="input w-full"
                                placeholder={t('taskModal.phTitle')}
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                required
                                minLength={1}
                                autoFocus
                                data-testid="task-title-input"
                            />
                        </FormField>
                        <FormField label={t('taskModal.descriptionField')}>
                            <textarea
                                id="task-desc-input"
                                className="input w-full"
                                rows={3}
                                placeholder={t('taskModal.phOptional')}
                                value={description}
                                onChange={(e) =>
                                    setDescription(e.target.value)
                                }
                                data-testid="task-desc-input"
                            />
                        </FormField>
                        <FormField label={t('taskModal.dueDate')}>
                            <DatePicker
                                id="task-due-input"
                                className="w-full"
                                placeholder={t('taskModal.phDate')}
                                clearable
                                align="start"
                                value={parseYMD(dueAt)}
                                onChange={(next) =>
                                    setDueAt(toYMD(next) ?? '')
                                }
                                disabledDays={{
                                    before: startOfUtcDay(new Date()),
                                }}
                                aria-label={t('taskModal.dueAria')}
                            />
                        </FormField>
                    </fieldset>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={onCancel}
                        disabled={saving}
                        data-testid="task-cancel-button"
                    >
                        {t('taskModal.cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        disabled={saving || title.trim().length === 0}
                        id="submit-task-btn"
                        data-testid="submit-task-btn"
                    >
                        {saving ? t('taskModal.creating') : t('taskModal.create')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
