'use client';

/**
 * B5 — Evidence edit modal.
 *
 * Pre-B5 evidence rows could not be edited after creation through
 * the UI — the `updateEvidence` usecase + the
 * `PATCH /api/t/:slug/evidence/:id` route both existed but no
 * client surface called them.
 *
 * Mirrors the canonical modal-form shape (NewVendorModal +
 * NewAssetModal) — wraps the existing `<Modal>` shell with a
 * disabled-while-submitting fieldset and an unsaved-changes guard
 * on close.
 */
import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { UserCombobox } from '@/components/ui/user-combobox';
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import {
    parseYMD,
    startOfUtcDay,
    toYMD,
} from '@/components/ui/date-picker/date-utils';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

export interface EditEvidenceModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    tenantSlug: string;
    initial: {
        id: string;
        title: string;
        description: string | null;
        ownerUserId: string | null;
        /** B8 follow-up — current folder label (null = unfoldered). */
        folder?: string | null;
        /** Retention date (ISO) — edited here now (was inline in the table). */
        retentionUntil?: string | null;
    } | null;
    onSaved?: () => void;
}

export function EditEvidenceModal({
    open,
    setOpen,
    tenantSlug,
    initial,
    onSaved,
}: EditEvidenceModalProps) {
    const t = useTranslations('evidence');
    const apiUrl = useTenantApiUrl();
    // SEEDED AT MOUNT, not in an effect (#1968). `EvidenceClient` remounts
    // this component for every open via a `key`, so `initial` is already the
    // right record on the first render and these ARE its values.
    //
    // The effect this replaces ran AFTER paint, so opening the editor for row
    // B directly after row A painted A's title for one frame — the wrong
    // record's data, not an empty field. Measured in
    // `tests/rendered/modal-seeds-after-paint.test.tsx`, which needs
    // `flushSync` to see it at all: `render`/`rerender` wrap updates in
    // `act()` and flush the very effect the defect lives in.
    //
    // The key is per-OPEN, not per-row, and that distinction is load-bearing:
    // the effect also reset `submitting`, `error` and `isDirty` on every open,
    // so keying on `initial.id` alone would skip the reset when the same row
    // is re-opened after a cancel — a quieter bug than the one being fixed.
    const seededRetention = initial?.retentionUntil
        ? initial.retentionUntil.split('T')[0]
        : '';
    const [title, setTitle] = useState(initial?.title ?? '');
    const [description, setDescription] = useState(initial?.description ?? '');
    const [ownerUserId, setOwnerUserId] = useState<string | null>(
        initial?.ownerUserId ?? null,
    );
    // B8 follow-up — folder is editable post-create.
    const [folder, setFolder] = useState(initial?.folder ?? '');
    // Retention date — moved here from the inline table column. Held as a
    // YMD string; the initial value is remembered so we only hit the
    // retention endpoint when it actually changes. It never changes after
    // mount now, so it needs no setter.
    const [retentionDate, setRetentionDate] = useState(seededRetention);
    const [initialRetention] = useState(seededRetention);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isDirty, setIsDirty] = useState(false);

    const canSubmit = title.trim().length > 0 && !submitting;

    const submit = async () => {
        if (!initial) return;
        setSubmitting(true);
        setError(null);
        try {
            const res = await fetch(apiUrl(`/evidence/${initial.id}`), {
                // The tenant evidence route exposes PUT (not PATCH) for
                // metadata updates; a PATCH 405'd, surfacing as the
                // generic "Failed to update evidence" on every save.
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title,
                    // `content`, not `description`. The column is `content`;
                    // "description" is the UI label. Sending the label name
                    // meant UpdateEvidenceSchema's `.strip()` dropped the
                    // field and the save reported success having changed
                    // nothing. `practiceId` had the same defect and was fixed
                    // the same way; GRC teardown phase 3 then removed the
                    // Practice model outright, so the field, its picker and
                    // its schema entry are all gone.
                    content: description || undefined,
                    ownerUserId: ownerUserId || null,
                    // B8 follow-up — empty string clears the folder
                    // (the usecase null-coerces); a non-empty value
                    // sets it. `undefined` would skip the update.
                    folder: folder.trim() || null,
                }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                setError(err.error?.message || t('edit.updateFailed'));
                return;
            }
            // Retention moved into this modal — persist via the dedicated
            // retention endpoint, but only when the date actually changed.
            if (retentionDate !== initialRetention) {
                const rr = await fetch(apiUrl(`/evidence/${initial.id}/retention`), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        retentionUntil: retentionDate
                            ? new Date(retentionDate).toISOString()
                            : null,
                        retentionPolicy: retentionDate ? 'FIXED_DATE' : 'NONE',
                    }),
                });
                if (!rr.ok) {
                    const err = await rr.json().catch(() => ({}));
                    setError(err.error?.message || t('edit.retentionFailed'));
                    return;
                }
            }
            setIsDirty(false);
            setOpen(false);
            onSaved?.();
        } finally {
            setSubmitting(false);
        }
    };

    const guardedSetOpen = useCallback<Dispatch<SetStateAction<boolean>>>(
        (next) => {
            const wantClose =
                typeof next === 'function' ? !next(true) : next === false;
            if (wantClose) {
                if (submitting) return;
                if (
                    isDirty &&
                    !window.confirm(t('edit.discardConfirm'))
                ) {
                    return;
                }
            }
            setOpen(next);
        },
        [submitting, isDirty, setOpen, t],
    );
    const close = () => guardedSetOpen(false);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        void submit();
    };

    const markDirty = () => setIsDirty(true);

    return (
        <Modal
            showModal={open}
            setShowModal={guardedSetOpen}
            size="lg"
            title={t('edit.title')}
            description={t('edit.description')}
            preventDefaultClose={submitting}
        >
            <Modal.Header
                title={t('edit.title')}
                description={t('edit.description')}
            />
            <Modal.Form id="edit-evidence-form" onSubmit={handleSubmit}>
                <Modal.Body>
                    {error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="edit-evidence-error"
                            role="alert"
                        >
                            {error}
                        </div>
                    )}
                    <fieldset
                        disabled={submitting}
                        className="m-0 p-0 border-0 space-y-default"
                    >
                        <FormField label={t('edit.fieldTitle')} required>
                            <Input
                                id="edit-evidence-title-input"
                                value={title}
                                onChange={(e) => {
                                    setTitle(e.target.value);
                                    markDirty();
                                }}
                                required
                            />
                        </FormField>
                        <FormField label={t('edit.fieldDescription')}>
                            <Textarea
                                id="edit-evidence-description"
                                className="h-24"
                                value={description}
                                onChange={(e) => {
                                    setDescription(e.target.value);
                                    markDirty();
                                }}
                            />
                        </FormField>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-default">
                            <FormField label={t('edit.fieldOwner')}>
                                <UserCombobox
                                    id="edit-evidence-owner-input"
                                    name="ownerUserId"
                                    tenantSlug={tenantSlug}
                                    selectedId={ownerUserId}
                                    onChange={(userId) => {
                                        setOwnerUserId(userId ?? null);
                                        markDirty();
                                    }}
                                    placeholder={t('edit.ownerPlaceholder')}
                                />
                            </FormField>
                        </div>
                        {/* B8 follow-up — folder is editable post-
                            create. Clearing the field re-files the
                            evidence as unfoldered. */}
                        <FormField label={t('edit.fieldFolder')}>
                            <Input
                                id="edit-evidence-folder-input"
                                data-testid="edit-evidence-folder-input"
                                value={folder}
                                onChange={(e) => {
                                    setFolder(e.target.value);
                                    markDirty();
                                }}
                                placeholder={t('edit.folderPlaceholder')}
                            />
                        </FormField>
                        {/* Retention date — moved here from the inline
                            table column. Clearing it sets the policy back
                            to NONE. */}
                        <FormField
                            label={t('edit.fieldRetention')}
                            description={t('edit.retentionFieldDescription')}
                        >
                            <DatePicker
                                id="edit-evidence-retention-input"
                                className="w-full"
                                placeholder={t('edit.retentionPlaceholder')}
                                clearable
                                align="start"
                                value={parseYMD(retentionDate)}
                                onChange={(next) => {
                                    setRetentionDate(toYMD(next) ?? '');
                                    markDirty();
                                }}
                                disabledDays={{ before: startOfUtcDay(new Date()) }}
                                aria-label={t('edit.retentionAria')}
                            />
                        </FormField>
                    </fieldset>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={close}
                        disabled={submitting}
                        id="edit-evidence-cancel-btn"
                    >
                        {t('edit.cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        disabled={!canSubmit}
                        id="edit-evidence-submit-btn"
                    >
                        {submitting ? t('edit.saving') : t('edit.saveChanges')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
