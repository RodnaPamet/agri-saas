'use client';

/**
 * NewArticleModal — create a Knowledge Base article.
 *
 * Mirrors NewPolicyModal (the Knowledge feature is the policy
 * feature's twin): a `<Modal.Form>` shell with the canonical
 * unsaved-changes discard guard (synchronous `window.confirm` on
 * close so a mis-click can't drop a typed draft). The content editor
 * is the shared TipTap `<RichTextEditor>`, lazy-loaded via
 * `next/dynamic` so its ~200KB chunk only lands when the modal opens.
 *
 * The modal owns its own open state and renders the caller-supplied
 * `trigger` element (cloned with an onClick). POSTs `/knowledge`
 * (201 → `{ id, slug, title }`) and reports the new article via
 * `onCreated` so the list page can navigate to it.
 */

import {
    cloneElement,
    isValidElement,
    useCallback,
    useState,
    type Dispatch,
    type ReactElement,
    type SetStateAction,
} from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiPost } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { SkeletonCard } from '@/components/ui/skeleton';
import type { RichTextContentType } from '@/components/ui/RichTextEditor';
import { AgronomyFieldsSection } from './AgronomyFieldsSection';

/** Parse a comma-separated field into a trimmed, non-empty array. Real
 *  sanitisation (dedupe, HTML strip, cap) happens server-side
 *  (`sanitizeTagArray` in `usecases/knowledge.ts`) — this only shapes the
 *  wire payload. */
function parseTagList(raw: string): string[] {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

const RichTextEditor = dynamic(
    () => import('@/components/ui/RichTextEditor').then((m) => m.RichTextEditor),
    { ssr: false, loading: () => <SkeletonCard lines={4} /> },
);

interface CreatedArticle {
    id: string;
    slug: string;
    title: string;
}

export interface NewArticleModalProps {
    /** Clickable element that opens the modal (cloned with onClick). */
    trigger: ReactElement;
    /** Called with the created article so the caller can navigate. */
    onCreated?: (article: CreatedArticle) => void;
}

export function NewArticleModal({ trigger, onCreated }: NewArticleModalProps) {
    const t = useTranslations('knowledge.modal');
    const tCommon = useTranslations('common');
    const buildUrl = useTenantApiUrl();
    const [open, setOpen] = useState(false);

    // ── Form state ──
    const [title, setTitle] = useState('');
    const [category, setCategory] = useState('');
    const [summary, setSummary] = useState('');
    const [content, setContent] = useState('');
    const [contentType, setContentType] = useState<RichTextContentType>('HTML');
    const [cropTags, setCropTags] = useState('');
    const [regions, setRegions] = useState('');
    const [bbchEnabled, setBbchEnabled] = useState(false);
    const [bbchMin, setBbchMin] = useState(0);
    const [bbchMax, setBbchMax] = useState(99);
    const [dirty, setDirty] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const markDirty = () => setDirty(true);

    const reset = () => {
        setTitle('');
        setCategory('');
        setSummary('');
        setContent('');
        setContentType('HTML');
        setCropTags('');
        setRegions('');
        setBbchEnabled(false);
        setBbchMin(0);
        setBbchMax(99);
        setDirty(false);
        setError(null);
    };

    const canSubmit = title.trim().length > 0 && !submitting;

    const submit = async () => {
        setSubmitting(true);
        setError(null);
        try {
            const body: Record<string, unknown> = {
                title: title.trim(),
                summary: summary.trim() || null,
                category: category.trim() || null,
                contentType,
                content: content.trim() || null,
                cropTags: parseTagList(cropTags),
                regions: parseTagList(regions),
                bbchStageMin: bbchEnabled ? bbchMin : null,
                bbchStageMax: bbchEnabled ? bbchMax : null,
            };
            const created = await apiPost<CreatedArticle>(
                buildUrl('/knowledge'),
                body,
            );
            setDirty(false);
            setOpen(false);
            reset();
            onCreated?.(created);
        } catch (err) {
            setError(
                err instanceof Error ? err.message : 'Failed to create article',
            );
        } finally {
            setSubmitting(false);
        }
    };

    // Unsaved-changes guard — same synchronous-close shape as
    // NewPolicyModal / JournalEntryModal.
    const guardedSetOpen = useCallback<Dispatch<SetStateAction<boolean>>>(
        (next) => {
            const wantClose =
                typeof next === 'function' ? !next(true) : next === false;
            if (wantClose) {
                if (submitting) return;
                if (
                    dirty &&
                    !window.confirm(t('discardConfirm'))
                ) {
                    return;
                }
            }
            setOpen(next);
        },
        [submitting, dirty],
    );
    const close = () => guardedSetOpen(false);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        void submit();
    };

    const triggerEl = isValidElement(trigger)
        ? cloneElement(trigger as ReactElement<{ onClick?: () => void }>, {
              onClick: () => setOpen(true),
          })
        : trigger;

    return (
        <>
            {triggerEl}
            <Modal
                showModal={open}
                setShowModal={guardedSetOpen}
                size="lg"
                title={t('title')}
                description={t('description')}
                preventDefaultClose={submitting}
            >
                <Modal.Header
                    title={t('title')}
                    description={t('description')}
                />
                <Modal.Form id="new-article-form" onSubmit={handleSubmit}>
                    <Modal.Body>
                        {error && (
                            <div
                                className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                                id="new-article-error"
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
                                    value={title}
                                    onChange={(e) => {
                                        setTitle(e.target.value);
                                        markDirty();
                                    }}
                                    placeholder={t('titlePlaceholder')}
                                    id="article-title-input"
                                />
                            </FormField>

                            <FormField label={t('fieldCategory')}>
                                <Input
                                    value={category}
                                    onChange={(e) => {
                                        setCategory(e.target.value);
                                        markDirty();
                                    }}
                                    placeholder={t('categoryPlaceholder')}
                                    id="article-category-input"
                                />
                            </FormField>

                            <FormField
                                label={t('fieldSummary')}
                                hint={t('summaryHint')}
                            >
                                <Input
                                    value={summary}
                                    onChange={(e) => {
                                        setSummary(e.target.value);
                                        markDirty();
                                    }}
                                    placeholder={t('summaryPlaceholder')}
                                    id="article-summary-input"
                                />
                            </FormField>

                            <FormField label={t('fieldContent')}>
                                <RichTextEditor
                                    id="article-content-editor"
                                    value={content}
                                    contentType={contentType}
                                    placeholder={t('contentPlaceholder')}
                                    onChange={(value, nextType) => {
                                        setContent(value);
                                        setContentType(nextType);
                                        markDirty();
                                    }}
                                    minHeightPx={200}
                                />
                            </FormField>

                            <AgronomyFieldsSection
                                idPrefix="new-article"
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
                            id="new-article-cancel-btn"
                        >
                            {tCommon('cancel')}
                        </Button>
                        <Button
                            type="submit"
                            variant="primary"
                            size="sm"
                            disabled={!canSubmit}
                            loading={submitting}
                            id="create-article-btn"
                        >
                            {t('create')}
                        </Button>
                    </Modal.Actions>
                </Modal.Form>
            </Modal>
        </>
    );
}
