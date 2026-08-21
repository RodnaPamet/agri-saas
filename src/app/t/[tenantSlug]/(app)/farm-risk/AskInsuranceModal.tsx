'use client';

/**
 * "Ask for offer" insurance-quote modal (#13). Lead-gen only: stores an
 * InsuranceLead (with a snapshot of the parcel's satellite risk) + a
 * confirmation notification. Mirrors the #12 offers AskForOfferModal.
 */
import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { apiPost } from '@/lib/api-client';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useToast } from '@/components/ui/hooks';
import { Tooltip } from '@/components/ui/tooltip';

interface AskInsuranceModalProps {
    parcelId: string;
    locationId: string;
    risk: { overall: string; ndvi: number | null; ndmi: number | null };
    /**
     * Server-read: has this tenant already requested a quote for this parcel?
     *
     * The durable half. `justSent` below is the optimistic half and is
     * deliberately NOT the source of truth — it only bridges the gap until the
     * page-level SWR read refreshes. Before this prop existed the optimistic
     * flag was ALL there was, so navigating away and back re-enabled a button
     * whose POST the database refuses: `InsuranceLead` carries
     * `@@unique([parcelId, inquirerTenantId])` and the usecase turns the P2002
     * into a 409. The operator retyped a quote request and was told off for it.
     */
    hasRequested?: boolean;
    /** Refresh the server-read list after a successful send. */
    onRequested?: () => void;
}

export function AskInsuranceModal({
    parcelId,
    locationId,
    risk,
    hasRequested = false,
    onRequested,
}: AskInsuranceModalProps) {
    const t = useTranslations('ag.risk.ask');
    const buildUrl = useTenantApiUrl();
    const toast = useToast();
    const [open, setOpen] = useState(false);
    const [message, setMessage] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Optimistic only — see `hasRequested`. `sent` is the union of the two.
    const [justSent, setJustSent] = useState(false);
    const sent = hasRequested || justSent;

    const canSubmit = message.trim().length > 0 && !submitting;

    /**
     * `Modal` types this as a state setter, so it may hand back an updater
     * function rather than a boolean. Resolving it here rather than casting
     * keeps the reset on EVERY close path.
     */
    const handleShowModal: Dispatch<SetStateAction<boolean>> = (v) => {
        const next = typeof v === 'function' ? v(open) : v;
        if (next) setOpen(true);
        else closeAndReset();
    };

    /** Close and clear what must not survive the modal. */
    function closeAndReset() {
        setOpen(false);
        setMessage('');
        setError(null);
    }

    async function submit() {
        setSubmitting(true);
        setError(null);
        try {
            await apiPost(buildUrl('/insurance/leads'), {
                parcelId,
                locationId,
                message: message.trim(),
                risk,
            });
            closeAndReset();
            setJustSent(true);
            // Re-read the server list so the durable flag catches up; the
            // optimistic one only covers the gap until it does.
            onRequested?.();
            toast.success(t('sentToast'));
        } catch (err) {
            setError(err instanceof Error ? err.message : t('error'));
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <>
            {sent ? (
                // A disabled control with no explanation is what sent the
                // operator back into the modal in the first place. Say why,
                // and keep it reachable — `disabled` drops an element out of
                // the tab order, putting the reason out of reach of exactly
                // the users most likely to need it.
                <Tooltip content={t('alreadySent')}>
                    <span
                        className="inline-flex cursor-default items-center rounded-md border border-border-subtle px-3 py-1.5 text-sm text-content-muted"
                        tabIndex={0}
                        role="note"
                    >
                        {t('sent')}
                    </span>
                </Tooltip>
            ) : (
                <Button variant="secondary" size="sm" type="button" onClick={() => setOpen(true)}>
                    {t('open')}
                </Button>
            )}
            <Modal
                showModal={open}
                // Every close path clears the draft, not just Cancel: the
                // backdrop and Escape both arrive through this prop rather
                // than through the button, so routing only the button leaves
                // a half-written quote request waiting on the next open.
                setShowModal={handleShowModal}
                size="md"
                title={t('title')}
                description={t('description')}
                preventDefaultClose={submitting}
                isDirty={message !== ''}
            >
                <Modal.Header title={t('title')} description={t('description')} />
                <Modal.Form
                    id="insurance-lead-form"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void submit();
                    }}
                >
                    <Modal.Body>
                        {error && (
                            <div role="alert" className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error">
                                {error}
                            </div>
                        )}
                        <fieldset disabled={submitting} className="m-0 space-y-default border-0 p-0">
                            <FormField label={t('message')} required>
                                <Textarea
                                    id="insurance-lead-message"
                                    rows={3}
                                    value={message}
                                    onChange={(e) => setMessage(e.target.value)}
                                    placeholder={t('messagePlaceholder')}
                                />
                            </FormField>
                        </fieldset>
                    </Modal.Body>
                    <Modal.Actions>
                        <Button variant="secondary" size="sm" type="button" onClick={closeAndReset} disabled={submitting}>
                            {t('cancel')}
                        </Button>
                        <Button variant="primary" size="sm" type="submit" loading={submitting} disabled={!canSubmit}>
                            {t('submit')}
                        </Button>
                    </Modal.Actions>
                </Modal.Form>
            </Modal>
        </>
    );
}
