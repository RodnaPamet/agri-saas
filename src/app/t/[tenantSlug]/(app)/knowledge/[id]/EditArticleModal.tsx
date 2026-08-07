'use client';

/**
 * EditArticleModal — edit a Knowledge Base article's metadata.
 *
 * Metadata only (title / summary / category / owner / language) — content
 * lives on versions and is edited via the detail page's Editor tab. Mirrors
 * the canonical edit-modal shape (`EditEvidenceModal`): a `<Modal.Form>`
 * shell with a disabled-while-submitting fieldset and a synchronous
 * unsaved-changes guard on close.
 *
 * PATCHes `/knowledge/:id` — the route that used to be dead code (the
 * `updateMetadata` repository method existed with zero callers). See
 * docs/implementation-notes/2026-08-07-knowledge-crud-defects.md.
 */

import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { UserCombobox } from '@/components/ui/user-combobox';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiPatch } from '@/lib/api-client';

export interface EditArticleModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    tenantSlug: string;
    initial: {
        id: string;
        title: string;
        summary: string | null;
        category: string | null;
        ownerUserId: string | null;
        language: string | null;
    } | null;
    onSaved?: () => void;
}

interface UpdatedArticle {
    id: string;
    title: string;
}

export function EditArticleModal({
    open,
    setOpen,
    tenantSlug,
    initial,
    onSaved,
}: EditArticleModalProps) {
    const t = useTranslations('knowledge.editModal');
    const tCommon = useTranslations('common');
    const apiUrl = useTenantApiUrl();

    const [title, setTitle] = useState('');
    const [category, setCategory] = useState('');
    const [summary, setSummary] = useState('');
    const [ownerUserId, setOwnerUserId] = useState<string | null>(null);
    const [language, setLanguage] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isDirty, setIsDirty] = useState(false);

    // Seed from `initial` when the modal opens; reset dirty + error each
    // time so a re-open after cancel reads clean.
    useEffect(() => {
        if (open && initial) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setTitle(initial.title);
            setCategory(initial.category ?? '');
            setSummary(initial.summary ?? '');
            setOwnerUserId(initial.ownerUserId);
            setLanguage(initial.language ?? '');
            setSubmitting(false);
            setError(null);
            setIsDirty(false);
        }
    }, [open, initial]);

    const canSubmit = title.trim().length > 0 && !submitting;
    const markDirty = () => setIsDirty(true);

    const submit = async () => {
        if (!initial) return;
        setSubmitting(true);
        setError(null);
        try {
            await apiPatch<UpdatedArticle>(apiUrl(`/knowledge/${initial.id}`), {
                title: title.trim(),
                summary: summary.trim() || null,
                category: category.trim() || null,
                ownerUserId: ownerUserId || null,
                language: language.trim() || null,
            });
            setIsDirty(false);
            setOpen(false);
            onSaved?.();
        } catch (err) {
            setError(err instanceof Error ? err.message : t('updateFailed'));
        } finally {
            setSubmitting(false);
        }
    };

    const guardedSetOpen = useCallback<Dispatch<SetStateAction<boolean>>>(
        (next) => {
            const wantClose = typeof next === 'function' ? !next(true) : next === false;
            if (wantClose) {
                if (submitting) return;
                if (isDirty && !window.confirm(t('discardConfirm'))) {
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

    return (
        <Modal
            showModal={open}
            setShowModal={guardedSetOpen}
            size="lg"
            title={t('title')}
            description={t('description')}
            preventDefaultClose={submitting}
        >
            <Modal.Header title={t('title')} description={t('description')} />
            <Modal.Form id="edit-article-form" onSubmit={handleSubmit}>
                <Modal.Body>
                    {error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="edit-article-error"
                            role="alert"
                        >
                            {error}
                        </div>
                    )}
                    <fieldset
                        disabled={submitting}
                        className="m-0 p-0 border-0 space-y-default"
                    >
                        <FormField label={t('fieldTitle')} required>
                            <Input
                                id="edit-article-title-input"
                                value={title}
                                onChange={(e) => {
                                    setTitle(e.target.value);
                                    markDirty();
                                }}
                                required
                            />
                        </FormField>
                        <FormField label={t('fieldCategory')}>
                            <Input
                                id="edit-article-category-input"
                                value={category}
                                onChange={(e) => {
                                    setCategory(e.target.value);
                                    markDirty();
                                }}
                                placeholder={t('categoryPlaceholder')}
                            />
                        </FormField>
                        <FormField label={t('fieldSummary')}>
                            <Input
                                id="edit-article-summary-input"
                                value={summary}
                                onChange={(e) => {
                                    setSummary(e.target.value);
                                    markDirty();
                                }}
                                placeholder={t('summaryPlaceholder')}
                            />
                        </FormField>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-default">
                            <FormField label={t('fieldOwner')}>
                                <UserCombobox
                                    id="edit-article-owner-input"
                                    name="ownerUserId"
                                    tenantSlug={tenantSlug}
                                    selectedId={ownerUserId}
                                    onChange={(userId) => {
                                        setOwnerUserId(userId ?? null);
                                        markDirty();
                                    }}
                                    placeholder={t('ownerPlaceholder')}
                                />
                            </FormField>
                            <FormField label={t('fieldLanguage')}>
                                <Input
                                    id="edit-article-language-input"
                                    value={language}
                                    onChange={(e) => {
                                        setLanguage(e.target.value);
                                        markDirty();
                                    }}
                                    placeholder={t('languagePlaceholder')}
                                    maxLength={8}
                                />
                            </FormField>
                        </div>
                    </fieldset>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        onClick={close}
                        disabled={submitting}
                        id="edit-article-cancel-btn"
                    >
                        {tCommon('cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        disabled={!canSubmit}
                        loading={submitting}
                        id="edit-article-submit-btn"
                    >
                        {submitting ? t('saving') : t('saveChanges')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
