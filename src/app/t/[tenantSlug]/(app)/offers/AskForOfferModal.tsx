'use client';

/**
 * "Ask for offer" modal — send a lead to a company promotion (#12).
 *
 * Lead-gen only: the message is sanitized server-side and stored as a
 * PromotionLead; the requester gets a confirmation notification. Mirrors the
 * Exchange InquiryModal shape.
 */
import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Checkbox } from '@/components/ui/checkbox';
import { env } from '@/env';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { apiPost } from '@/lib/api-client';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useToast } from '@/components/ui/hooks';

interface AskForOfferModalProps {
    promotionId: string;
    company: string;
    /**
     * Server-read: has this tenant already sent a lead for this promotion?
     *
     * This is the durable half. `justSent` below is the optimistic half, and
     * it is deliberately NOT the source of truth — it only bridges the gap
     * until the server component re-renders. Before this prop existed the
     * optimistic flag was ALL there was, so navigating away and back
     * re-enabled a button whose POST the database would refuse with a 409.
     */
    hasRequested?: boolean;
}

export function AskForOfferModal({ promotionId, company, hasRequested = false }: AskForOfferModalProps) {
    const t = useTranslations('ag.offers.ask');
    const buildUrl = useTenantApiUrl();
    const toast = useToast();
    const [open, setOpen] = useState(false);
    const [message, setMessage] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Optimistic only — see `hasRequested` above. `sent` is the union.
    const [justSent, setJustSent] = useState(false);
    const sent = hasRequested || justSent;
    // Consent is a submit PRE-CONDITION, not a field that can be left blank:
    // the request only exists to be forwarded to a supplier, so an unticked
    // box means there is nothing lawful to send.
    //
    // It is reset explicitly on every close (see `closeAndReset`). The
    // comment here used to CLAIM it "starts false every time", which was
    // false — nothing reset it, and open → tick → Cancel → re-open left the
    // box ticked. `consentedAt` is the lawfulness record, so a stale tick is
    // the one piece of this form that must not persist by accident.
    const [consent, setConsent] = useState(false);
    // The in-app /privacy page now exists, so this always resolves. The env
    // var stays as an override for an operator who hosts their own policy.
    const privacyUrl = env.NEXT_PUBLIC_PRIVACY_URL ?? '/privacy';

    const canSubmit = message.trim().length > 0 && consent && !submitting;

    /**
     * `Modal` types this as a state setter, so it may hand back an updater
     * function rather than a boolean. Resolving it here rather than casting
     * keeps the reset on EVERY close path — backdrop click and Escape both
     * arrive through this prop, not through the Cancel button.
     */
    const handleShowModal: Dispatch<SetStateAction<boolean>> = (v) => {
        const next = typeof v === 'function' ? v(open) : v;
        if (next) setOpen(true);
        else closeAndReset();
    };

    /** Close and clear everything that must not survive the modal. */
    function closeAndReset() {
        setOpen(false);
        setMessage('');
        setConsent(false);
        setError(null);
    }

    async function submit() {
        setSubmitting(true);
        setError(null);
        try {
            await apiPost(buildUrl('/offers/leads'), {
                promotionId,
                message: message.trim(),
                consent,
            });
            closeAndReset();
            setJustSent(true);
            // The modal closing is not by itself a confirmation — it is what
            // Cancel does too. Say so, and say where the record lives: the
            // server also writes an in-app notification, which is the thing
            // that survives this page.
            toast.success(t('sentToast', { company }));
        } catch (err) {
            setError(err instanceof Error ? err.message : t('error'));
        } finally {
            setSubmitting(false);
        }
    }

    const title = t('titleWithCompany', { company });

    return (
        <>
            {sent ? (
                // A disabled control with no explanation is the shape that
                // sent the operator back into the modal in the first place.
                // Say WHY it is disabled, and keep it reachable by keyboard
                // and screen reader — `disabled` removes it from the tab
                // order, so the reason would be unreachable to exactly the
                // users most likely to need it.
                <Tooltip content={t('alreadySent', { company })}>
                    <span
                        className="inline-flex cursor-default items-center rounded-md border border-border-subtle px-3 py-1.5 text-sm text-content-muted"
                        tabIndex={0}
                        role="note"
                    >
                        {t('sent')}
                    </span>
                </Tooltip>
            ) : (
                <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    onClick={() => setOpen(true)}
                >
                    {t('open')}
                </Button>
            )}
            <Modal
                showModal={open}
                // Every close path clears consent, not just Cancel: the
                // backdrop and Escape both come through here, and a tick
                // that survives an accidental dismissal is a consent record
                // the operator did not knowingly give on the next open.
                setShowModal={handleShowModal}
                size="md"
                title={title}
                description={t('description', { company })}
                preventDefaultClose={submitting}
                isDirty={message !== ''}
            >
                <Modal.Header title={title} description={t('description', { company })} />
                <Modal.Form
                    id="offer-lead-form"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void submit();
                    }}
                >
                    <Modal.Body>
                        {error && (
                            <div
                                role="alert"
                                className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            >
                                {error}
                            </div>
                        )}
                        <fieldset disabled={submitting} className="m-0 space-y-default border-0 p-0">
                            <FormField label={t('message')} required>
                                <Textarea
                                    id="offer-lead-message"
                                    rows={3}
                                    value={message}
                                    onChange={(e) => setMessage(e.target.value)}
                                    placeholder={t('messagePlaceholder')}
                                />
                            </FormField>
                            {/* FormField owns the label element and the
                                htmlFor/id wiring, so the consent sentence stays
                                a real, clickable label without this file
                                hand-rolling a raw <label> (the coverage guard's
                                whole point). The privacy link renders only when
                                an operator has configured a real policy URL —
                                this app ships no privacy page, and pointing the
                                consent notice at a 404 would be the same broken
                                promise the rest of this work removes. */}
                            <FormField
                                label={
                                    <span className="font-normal text-content-muted">
                                        {t('consent', { company })}
                                        {' '}
                                        <Link
                                            href={privacyUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="underline hover:text-content-emphasis"
                                        >
                                            {t('privacyLink')}
                                        </Link>
                                    </span>
                                }
                                required
                            >
                                <Checkbox
                                    id="offer-lead-consent"
                                    checked={consent}
                                    onCheckedChange={(v) => setConsent(v === true)}
                                />
                            </FormField>
                        </fieldset>
                    </Modal.Body>
                    <Modal.Actions>
                        <Button
                            variant="secondary"
                            size="sm"
                            type="button"
                            onClick={closeAndReset}
                            disabled={submitting}
                        >
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
