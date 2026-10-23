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

import { useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { UserCombobox } from '@/components/ui/user-combobox';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiPatch } from '@/lib/api-client';
import { AgronomyFieldsSection } from '../AgronomyFieldsSection';

/** Parse a comma-separated field into a trimmed, non-empty array. Real
 *  sanitisation (dedupe, HTML strip, cap) happens server-side
 *  (`sanitizeTagArray` in `usecases/knowledge.ts`) — this only shapes the
 *  wire payload. */
function parseTagList(raw: string): string[] {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

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
        cropTags: string[];
        regions: string[];
        bbchStageMin: number | null;
        bbchStageMax: number | null;
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

    // SEEDED AT MOUNT, not in an effect (#1968). The article page remounts
    // this component for every open via a `key`, so `initial` is already the
    // right article on the first render.
    //
    // This one was not only a stale frame. The effect's deps were
    // `[open, initial]` and the call site passes `initial={{ … }}` — a fresh
    // object on EVERY parent render. The page holds seven state hooks
    // (`article`, `tab`, `contentType`, …), so any re-render while the modal
    // was open re-ran the seed and DISCARDED whatever the user had typed,
    // then set `isDirty` back to false — which also disarms the
    // unsaved-changes guard, so the loss happened without the prompt that
    // exists to prevent it.
    //
    // Seeding at mount removes the dependency entirely: there is nothing to
    // re-run.
    const [title, setTitle] = useState(initial?.title ?? '');
    const [category, setCategory] = useState(initial?.category ?? '');
    const [summary, setSummary] = useState(initial?.summary ?? '');
    const [ownerUserId, setOwnerUserId] = useState<string | null>(
        initial?.ownerUserId ?? null,
    );
    const [language, setLanguage] = useState(initial?.language ?? '');
    const [cropTags, setCropTags] = useState(initial?.cropTags.join(', ') ?? '');
    const [regions, setRegions] = useState(initial?.regions.join(', ') ?? '');
    const [bbchEnabled, setBbchEnabled] = useState(
        initial?.bbchStageMin != null && initial?.bbchStageMax != null,
    );
    const [bbchMin, setBbchMin] = useState(initial?.bbchStageMin ?? 0);
    const [bbchMax, setBbchMax] = useState(initial?.bbchStageMax ?? 99);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isDirty, setIsDirty] = useState(false);

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
                cropTags: parseTagList(cropTags),
                regions: parseTagList(regions),
                bbchStageMin: bbchEnabled ? bbchMin : null,
                bbchStageMax: bbchEnabled ? bbchMax : null,
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

    // #2209 - the hand-rolled close guard is GONE, both halves of it.
    //
    //   - the DIRTY half is the Modal primitive's `isDirty` prop, which
    //     renders the design system's own <Confirm> on every dismiss (X,
    //     Escape, outside-click, mobile drag), mounted as a sibling of the
    //     surface so it stacks above it;
    //   - the SUBMITTING half is `preventDefaultClose`, which this modal
    //     already passed.
    //
    // So `setShowModal` goes straight to `setOpen`. This is the shape
    // `NewTaskModal` has had since mobile-forms PR-3, and it is what the two
    // guards grading this family require for a flow marked `guard: 'native'`
    // - they assert the wrapper is ABSENT, not merely thinned.
    const close = () => setOpen(false);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        void submit();
    };

    return (
        <Modal
            showModal={open}
            setShowModal={setOpen}
            size="lg"
            title={t('title')}
            description={t('description')}
            preventDefaultClose={submitting}
            isDirty={isDirty}
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

                        <AgronomyFieldsSection
                            idPrefix="edit-article"
                            disabled={submitting}
                            cropTags={cropTags}
                            onCropTagsChange={(v) => { setCropTags(v); markDirty(); }}
                            regions={regions}
                            onRegionsChange={(v) => { setRegions(v); markDirty(); }}
                            bbchEnabled={bbchEnabled}
                            onBbchEnabledChange={(v) => { setBbchEnabled(v); markDirty(); }}
                            bbchMin={bbchMin}
                            onBbchMinChange={(v) => { setBbchMin(v); markDirty(); }}
                            bbchMax={bbchMax}
                            onBbchMaxChange={(v) => { setBbchMax(v); markDirty(); }}
                        />
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
