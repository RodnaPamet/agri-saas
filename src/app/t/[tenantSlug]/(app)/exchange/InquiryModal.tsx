'use client';

/**
 * Express-interest modal — send an inquiry to a listing's seller.
 *
 * The inquiry is the ONLY channel through which contact happens: the seller
 * receives an in-app notification + email and chooses whether to respond.
 * message is sanitized server-side. Only shown for OTHER tenants' listings
 * (the caller hides it on your own).
 *
 * Two disclosures, both BEFORE the user types anything:
 *
 *   1. WHO reads this. The modal used to say "the seller is notified", which
 *      reads as one person. `notifySellerOfInquiry` emails the message to
 *      every ACTIVE OWNER/ADMIN of the seller tenant, up to 25 of them, off
 *      the platform. Someone deciding how much to put in a free-text message
 *      is entitled to know that before they write it, not after.
 *   2. WHAT happens to `inquirerContact`. It is optional, and it is released
 *      to the seller only if they ACCEPT — the same consent gate the seller's
 *      own contact passes through. That is stated in the field's always-
 *      visible `description` (never a hover-only `hint`), so the promise sits
 *      next to the input that makes it and cannot be missed.
 */
import { useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { apiPost } from '@/lib/api-client';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import type { ExchangePublicListing } from '@/lib/exchange/public-listing';

interface InquiryModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    listing: ExchangePublicListing | null;
    onSent: () => void;
}

export function InquiryModal({ open, setOpen, listing, onSent }: InquiryModalProps) {
    const t = useTranslations('exchange.inquiry');
    const buildUrl = useTenantApiUrl();
    const [message, setMessage] = useState('');
    const [quantity, setQuantity] = useState('');
    const [contact, setContact] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const canSubmit = message.trim().length > 0 && !submitting && !!listing;

    async function submit() {
        if (!listing) return;
        setSubmitting(true);
        setError(null);
        try {
            await apiPost(buildUrl('/exchange/inquiries'), {
                listingId: listing.id,
                message: message.trim(),
                quantityTonnes: quantity.trim() === '' ? null : quantity.trim(),
                // Optional. Held private until the seller accepts.
                inquirerContact: contact.trim() === '' ? null : contact.trim(),
            });
            setOpen(false);
            setMessage('');
            setQuantity('');
            setContact('');
            onSent();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to send inquiry');
        } finally {
            setSubmitting(false);
        }
    }

    const title = listing ? t('titleWithCommodity', { commodity: listing.commodity }) : t('title');

    return (
        <Modal
            showModal={open}
            setShowModal={setOpen}
            size="md"
            title={title}
            description={t('description')}
            preventDefaultClose={submitting}
            isDirty={message !== '' || quantity !== '' || contact !== ''}
        >
            <Modal.Header title={title} description={t('headerDescription')} />
            <Modal.Form id="exchange-inquiry-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
                <Modal.Body>
                    {error && (
                        <div role="alert" className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error">
                            {error}
                        </div>
                    )}
                    <fieldset disabled={submitting} className="m-0 space-y-default border-0 p-0">
                        <FormField label={t('quantity')} hint={t('quantityHint')}>
                            <Input id="inquiry-qty" inputMode="decimal" autoComplete="off" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder={t('quantityPlaceholder')} />
                        </FormField>
                        <FormField label={t('message')} required>
                            <Textarea id="inquiry-message" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder={t('messagePlaceholder')} />
                        </FormField>
                        {/* Optional, and consented: released to the seller only
                            on ACCEPT. Sits AFTER the message so the recipient
                            disclosure above has already been read. */}
                        <FormField label={t('contact')} description={t('contactConsent')}>
                            <Input
                                id="inquiry-contact"
                                autoComplete="off"
                                value={contact}
                                onChange={(e) => setContact(e.target.value)}
                                placeholder={t('contactPlaceholder')}
                                maxLength={200}
                            />
                        </FormField>
                    </fieldset>
                </Modal.Body>
                <Modal.Actions>
                    <Button variant="secondary" size="sm" type="button" onClick={() => setOpen(false)} disabled={submitting}>
                        {t('cancel')}
                    </Button>
                    <Button variant="primary" size="sm" type="submit" loading={submitting} disabled={!canSubmit}>
                        {t('submit')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
