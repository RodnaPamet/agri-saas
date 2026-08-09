'use client';

/**
 * KnowledgeAskModal — the RAG-grounded "ask" box on the Knowledge Base
 * list page (W4/#92).
 *
 * Self-contained trigger + modal, same shape as `NewArticleModal`. POSTs
 * `/knowledge/ask` (W3/#91's route over the existing `askKnowledgeBase`
 * usecase) and renders exactly ONE of three mutually-exclusive states:
 *
 *   1. A real request failure (network, permission denial, rate limit,
 *      validation) → the `error` banner. This is the ONLY state that
 *      means "something went wrong".
 *   2. A successful response with zero sources → the `no-results` empty
 *      state. `askKnowledgeBase` already returns the fixed "not in my
 *      sources" answer WITHOUT calling the model when retrieval finds
 *      nothing (`ai/rag/build-context.ts::NO_SOURCES_ANSWER`) — this is
 *      an HONEST negative result, not a failure, so it must never share
 *      styling or copy with state 1.
 *   3. A successful response with sources → the answer + its citation
 *      list (every source traceable back to its provenance label).
 *
 * Keeping (1) and (2) visually and semantically distinct is the whole
 * point of this component: PR #497 fixed a bug on this exact page where
 * a 500 rendered as a confident "no articles match" empty state.
 * Collapsing "the request failed" and "nothing was found" into one
 * render path here would be the same bug in a new shape.
 */

import {
    cloneElement,
    isValidElement,
    useState,
    type ReactElement,
} from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/ui/empty-state';
import { apiPost, ApiClientError } from '@/lib/api-client';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

interface AskSource {
    id: string;
    source: string;
    sourceType: string;
    language: string | null;
}

interface AskResponse {
    answer: string;
    sources: AskSource[];
}

const MAX_QUERY_LENGTH = 500;

export interface KnowledgeAskModalProps {
    /** Clickable element that opens the modal (cloned with onClick). */
    trigger: ReactElement;
}

export function KnowledgeAskModal({ trigger }: KnowledgeAskModalProps) {
    const t = useTranslations('knowledge.ask');
    const tCommon = useTranslations('common');
    const buildUrl = useTenantApiUrl();

    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [result, setResult] = useState<AskResponse | null>(null);
    const [error, setError] = useState<string | null>(null);

    const canSubmit = query.trim().length > 0 && !submitting;

    const reset = () => {
        setQuery('');
        setResult(null);
        setError(null);
    };

    const submit = async () => {
        setSubmitting(true);
        setError(null);
        setResult(null);
        try {
            const res = await apiPost<AskResponse>(buildUrl('/knowledge/ask'), {
                query: query.trim(),
            });
            setResult(res);
        } catch (err) {
            // A real failure — network, 403 (no `knowledge.view`), 429
            // (KNOWLEDGE_ASK_LIMIT), or a validation 400. Never silently
            // reinterpreted as "no results".
            setError(err instanceof ApiClientError ? err.message : t('genericError'));
        } finally {
            setSubmitting(false);
        }
    };

    const close = () => {
        if (submitting) return;
        setOpen(false);
        reset();
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
                setShowModal={(next) => {
                    // Modal only ever calls this with `false` (overlay click,
                    // Escape, its own close button) — opening happens via the
                    // cloned trigger's onClick above.
                    if (next === false) close();
                }}
                size="md"
                title={t('title')}
                description={t('description')}
                preventDefaultClose={submitting}
            >
                <Modal.Header title={t('title')} description={t('description')} />
                <Modal.Form
                    id="knowledge-ask-form"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void submit();
                    }}
                >
                    <Modal.Body>
                        <fieldset disabled={submitting} className="m-0 space-y-default border-0 p-0">
                            <FormField label={t('queryLabel')}>
                                <Textarea
                                    id="knowledge-ask-query"
                                    rows={2}
                                    maxLength={MAX_QUERY_LENGTH}
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                    placeholder={t('queryPlaceholder')}
                                />
                            </FormField>
                        </fieldset>

                        {/* State 1 — a real failure. */}
                        {error && (
                            <div
                                role="alert"
                                id="knowledge-ask-error"
                                className="mt-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            >
                                {error}
                            </div>
                        )}

                        {/* State 2 — an honest "nothing found" (not a failure). */}
                        {result && result.sources.length === 0 && (
                            <div className="mt-4">
                                <EmptyState
                                    size="sm"
                                    variant="no-results"
                                    title={t('noResultsTitle')}
                                    description={t('noResultsDescription')}
                                    data-testid="knowledge-ask-no-results"
                                />
                            </div>
                        )}

                        {/* State 3 — a grounded answer, with its citations. */}
                        {result && result.sources.length > 0 && (
                            <div className="mt-4 space-y-default" id="knowledge-ask-answer">
                                <p className="whitespace-pre-wrap text-sm text-content-default">
                                    {result.answer}
                                </p>
                                <div className="space-y-tight">
                                    <p className="text-xs font-medium uppercase tracking-wide text-content-subtle">
                                        {t('sourcesLabel')}
                                    </p>
                                    <ul className="space-y-tight">
                                        {result.sources.map((s) => (
                                            <li key={s.id} className="text-xs text-content-subtle">
                                                {s.source}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            </div>
                        )}
                    </Modal.Body>
                    <Modal.Actions>
                        <Button variant="secondary" size="sm" type="button" onClick={close} disabled={submitting}>
                            {tCommon('close')}
                        </Button>
                        {/* The LAST button in a Modal.Actions block must be
                            `primary` (tests/guards/modal-action-order.test.ts)
                            — this PR's new primary here is paid for by a
                            demotion elsewhere (see
                            tests/guards/primary-secondary-ratio.test.ts and
                            the corresponding demotion in this same diff). */}
                        <Button variant="primary" size="sm" type="submit" loading={submitting} disabled={!canSubmit}>
                            {t('submit')}
                        </Button>
                    </Modal.Actions>
                </Modal.Form>
            </Modal>
        </>
    );
}
