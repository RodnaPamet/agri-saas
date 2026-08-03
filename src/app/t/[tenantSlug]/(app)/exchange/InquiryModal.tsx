'use client';

/**
 * Express-interest modal — send an inquiry to a listing's seller.
 *
 * The inquiry is the ONLY channel through which contact happens: the seller
 * receives an in-app notification + email and chooses whether to respond.
 * message is sanitized server-side. Only shown for OTHER tenants' listings
 * (the caller hides it on your own).
 */
import { useState, type Dispatch, type SetStateAction } from 'react';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { apiPost } from '@/lib/api-client';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useTranslations, useLocale } from 'next-intl';
import { localizedCommodityLabel, asExchangeLocale } from '@/lib/exchange/commodities';
import type { ExchangePublicListing } from '@/lib/exchange/public-listing';

interface InquiryModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    listing: ExchangePublicListing | null;
    onSent: () => void;
}

export function InquiryModal({ open, setOpen, listing, onSent }: InquiryModalProps) {
    const t = useTranslations('exchange');
    const locale = asExchangeLocale(useLocale());
    const buildUrl = useTenantApiUrl();
    const [message, setMessage] = useState('');
    const [quantity, setQuantity] = useState('');
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
            });
            setOpen(false);
            setMessage('');
            setQuantity('');
            onSent();
        } catch (err) {
            setError(err instanceof Error ? err.message : t('inquiry.error'));
        } finally {
            setSubmitting(false);
        }
    }

    const title = listing
        ? t('inquiry.title', { commodity: localizedCommodityLabel(listing.commodityKey, listing.commodity, locale) })
        : t('inquiry.titleBare');

    return (
        <Modal
            showModal={open}
            setShowModal={setOpen}
            size="md"
            title={title}
            description={t('inquiry.subtitle')}
            preventDefaultClose={submitting}
            isDirty={message !== '' || quantity !== ''}
        >
            <Modal.Header title={title} description={t('inquiry.subtitle')} />
            <Modal.Form id="exchange-inquiry-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
                <Modal.Body>
                    {error && (
                        <div role="alert" className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error">
                            {error}
                        </div>
                    )}
                    <fieldset disabled={submitting} className="m-0 space-y-default border-0 p-0">
                        <FormField label={t('inquiry.quantity')} hint={t('inquiry.quantityHint')}>
                            <Input id="inquiry-qty" inputMode="decimal" autoComplete="off" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder={t('inquiry.quantityPlaceholder')} />
                        </FormField>
                        <FormField label={t('inquiry.message')} required>
                            <Textarea id="inquiry-message" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder={t('inquiry.messagePlaceholder')} />
                        </FormField>
                    </fieldset>
                </Modal.Body>
                <Modal.Actions>
                    <Button variant="secondary" size="sm" type="button" onClick={() => setOpen(false)} disabled={submitting}>
                        {t('inquiry.cancel')}
                    </Button>
                    <Button variant="primary" size="sm" type="submit" loading={submitting} disabled={!canSubmit}>
                        {t('inquiry.submit')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
