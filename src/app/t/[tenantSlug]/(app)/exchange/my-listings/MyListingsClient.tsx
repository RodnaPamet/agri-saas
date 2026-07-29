'use client';

/**
 * "My listings" — the seller's management view. Each of the tenant's own
 * listings (any status) with its inquiries. Withdraw (undo-toast) / fulfill a
 * listing; accept / decline (Reject) each PENDING inquiry.
 *
 * Every mutation here can fail, and every failure has to be visible. The
 * accept / decline / fulfil handlers used to run `try/finally` with no
 * `catch`: a 400 from the state machine (`listing_terminal`,
 * `listing_not_active`, `inquiry_not_pending`) became an unhandled rejection,
 * the spinner stopped, and the row looked exactly as it had before — and when
 * the action was driven from the confirm dialog, the rejection propagated into
 * `Modal.Confirm`, which deliberately keeps the dialog OPEN on a throw "so the
 * caller can surface an error". No caller surfaced one, so the dialog simply
 * sat there. Each handler now catches, tells the user, and resolves — so the
 * dialog closes and the error is the thing that moved.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { Heading } from '@/components/ui/typography';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { CopyText } from '@/components/ui/copy-text';
import { ErrorState } from '@/components/ui/error-state';
import { ConfirmDialog, type ConfirmTone } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast, useToastWithUndo } from '@/components/ui/hooks';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { apiPatch } from '@/lib/api-client';
import type { ExchangePublicListing } from '@/lib/exchange/public-listing';
import { ExchangeNav } from '../ExchangeNav';

interface MyInquiry {
    id: string;
    message: string;
    quantityTonnes: string | null;
    status: string;
    createdAt: string;
    /**
     * The BUYER's contact — computed by `toPublicInquiry`'s reveal gate, which
     * hands each viewer the OTHER side's details. Null until this seller
     * accepts, and null forever on a decline.
     */
    counterpartyContact: string | null;
    contactSharedAt: string | null;
}
type MyListing = ExchangePublicListing & { inquiries: MyInquiry[] };

function statusVariant(status: string): 'success' | 'neutral' | 'info' | 'warning' {
    if (status === 'ACTIVE' || status === 'ACCEPTED') return 'success';
    if (status === 'PENDING') return 'warning';
    if (status === 'FULFILLED') return 'info';
    return 'neutral';
}

/** Listing lifecycle → i18n key. Unknown values fall back to the raw enum. */
const LISTING_STATUS_KEY: Record<string, string> = {
    ACTIVE: 'listingStatusActive',
    EXPIRED: 'listingStatusExpired',
    FULFILLED: 'listingStatusFulfilled',
    WITHDRAWN: 'listingStatusWithdrawn',
};

/** Inquiry status → i18n key. Unknown values fall back to the raw enum. */
const INQUIRY_STATUS_KEY: Record<string, string> = {
    PENDING: 'inquiryStatusPending',
    ACCEPTED: 'inquiryStatusAccepted',
    DECLINED: 'inquiryStatusDeclined',
};

export function MyListingsClient() {
    const t = useTranslations('exchange.myListings');
    const buildUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const toast = useToast();
    const triggerUndoToast = useToastWithUndo();
    const { data, isLoading, error, mutate } = useTenantSWR<MyListing[]>('/exchange/my-listings');
    const listings = data ?? [];
    const [busy, setBusy] = useState<string | null>(null);
    // A single confirm surface driven by the pending destructive action.
    const [confirm, setConfirm] = useState<
        { title: string; description: string; tone: ConfirmTone; confirmLabel: string; action: () => Promise<void> } | null
    >(null);

    const withdrawListing = (listing: MyListing) => {
        const previous = listings;
        // Optimistically flip status to WITHDRAWN.
        void mutate(
            listings.map((l) => (l.id === listing.id ? { ...l, status: 'WITHDRAWN' } : l)),
            { revalidate: false },
        );
        triggerUndoToast({
            message: t('withdrawnToast'),
            undoMessage: t('undo'),
            action: async () => {
                await apiPatch(buildUrl(`/exchange/listings/${listing.id}`), { action: 'WITHDRAWN' });
                await mutate();
            },
            undoAction: () => { void mutate(previous, { revalidate: false }); },
            // The reference shape for the two handlers below: roll the
            // optimistic change back, then say what happened. The rollback
            // alone was silent — the row un-withdrew itself and the seller was
            // left to notice.
            onError: (err) => {
                void mutate(previous, { revalidate: false });
                showActionError(err);
            },
        });
    };

    /**
     * One error surface for every mutation on this page. The API's message is
     * preferred when there is one — the listing state machine returns copy
     * that names the listing and the reason ("… has expired — withdraw it
     * instead of marking it fulfilled"), which beats any generic fallback.
     */
    function showActionError(err: unknown) {
        const message = err instanceof Error && err.message ? err.message : t('actionFailed');
        toast.error(message);
    }

    async function fulfillListing(id: string) {
        setBusy(id);
        try {
            await apiPatch(buildUrl(`/exchange/listings/${id}`), { action: 'FULFILLED' });
            await mutate();
        } catch (err) {
            // Caught, NOT re-thrown: the confirm dialog closes only when its
            // onConfirm resolves, and a wedged-open dialog with no explanation
            // is a worse failure than the one that caused it.
            showActionError(err);
        } finally {
            setBusy(null);
        }
    }

    async function respond(inquiryId: string, action: 'ACCEPTED' | 'DECLINED') {
        setBusy(inquiryId);
        try {
            await apiPatch(buildUrl(`/exchange/inquiries/${inquiryId}`), { action });
            await mutate();
        } catch (err) {
            showActionError(err);
        } finally {
            setBusy(null);
        }
    }

    return (
        <>
        <ListPageShell>
            <ListPageShell.Header>
                <PageBreadcrumbs
                    items={[
                        { label: t('breadcrumbDashboard'), href: tenantHref('/dashboard') },
                        { label: t('breadcrumbExchange'), href: tenantHref('/exchange') },
                        { label: t('breadcrumbCurrent') },
                    ]}
                    className="mb-1"
                />
                <Heading level={1}>{t('heading')}</Heading>
                <ExchangeNav />
            </ListPageShell.Header>
            <ListPageShell.Body>
                <div className="min-h-0 flex-1 space-y-default overflow-y-auto pr-1">
                    {error ? (
                        <ErrorState
                            description={t('loadError')}
                            onRetry={() => { void mutate(); }}
                        />
                    ) : isLoading ? (
                        <div className="space-y-default" aria-busy="true">
                            {[0, 1, 2].map((i) => (
                                <Skeleton key={i} className="h-28 w-full rounded-lg" />
                            ))}
                        </div>
                    ) : listings.length === 0 ? (
                        <div className="rounded-lg border border-border-subtle p-4 text-sm text-content-muted">
                            {t('empty')}
                        </div>
                    ) : (
                    listings.map((l) => (
                        <div
                            key={l.id}
                            id={`listing-${l.id}`}
                            className="space-y-default rounded-lg border border-border-subtle p-4 scroll-mt-4"
                        >
                            <div className="flex flex-wrap items-center gap-compact">
                                <span className="font-medium text-content-emphasis">{l.commodity}</span>
                                <span className="text-xs text-content-muted">{l.side === 'SELL' ? t('selling') : t('buying')}</span>
                                <StatusBadge variant={statusVariant(l.status)}>
                                    {LISTING_STATUS_KEY[l.status] ? t(LISTING_STATUS_KEY[l.status]) : l.status}
                                </StatusBadge>
                                <span className="text-sm text-content-secondary">
                                    {l.quantityTonnes} t{l.pricePerTonne ? ` · ${l.pricePerTonne} ${l.priceCurrency}/t` : ''} · {l.regionName}
                                </span>
                                {l.status === 'ACTIVE' && (
                                    <span className="ml-auto flex gap-compact">
                                        <Button
                                            variant="secondary"
                                            size="sm"
                                            loading={busy === l.id}
                                            onClick={() => setConfirm({
                                                title: t('fulfillTitle'),
                                                description: t('fulfillDescription'),
                                                tone: 'warning',
                                                confirmLabel: t('markFulfilled'),
                                                action: () => fulfillListing(l.id),
                                            })}
                                        >
                                            {t('markFulfilled')}
                                        </Button>
                                        <Button variant="secondary" size="sm" onClick={() => withdrawListing(l)}>
                                            {t('withdraw')}
                                        </Button>
                                    </span>
                                )}
                            </div>

                            {l.inquiries.length > 0 ? (
                                <ul className="space-y-tight border-t border-border-subtle pt-default">
                                    {l.inquiries.map((iq) => (
                                        <li key={iq.id} className="space-y-tight text-sm">
                                            <div className="flex flex-wrap items-center gap-compact">
                                                <StatusBadge variant={statusVariant(iq.status)}>
                                                    {INQUIRY_STATUS_KEY[iq.status] ? t(INQUIRY_STATUS_KEY[iq.status]) : iq.status}
                                                </StatusBadge>
                                                {iq.quantityTonnes && <span className="text-content-muted">{iq.quantityTonnes} t</span>}
                                                <span className="text-content-secondary">{iq.message}</span>
                                                {iq.status === 'PENDING' && (
                                                    <span className="ml-auto flex gap-compact">
                                                        <Button variant="secondary" size="sm" onClick={() => respond(iq.id, 'ACCEPTED')} loading={busy === iq.id}>
                                                            {t('accept')}
                                                        </Button>
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            loading={busy === iq.id}
                                                            onClick={() => setConfirm({
                                                                title: t('rejectTitle'),
                                                                description: t('rejectDescription'),
                                                                tone: 'danger',
                                                                confirmLabel: t('reject'),
                                                                action: () => respond(iq.id, 'DECLINED'),
                                                            })}
                                                        >
                                                            {t('reject')}
                                                        </Button>
                                                    </span>
                                                )}
                                            </div>

                                            {/* Accept is a consent action, so it says
                                                so before the click rather than after.
                                                Inline copy, not a confirm dialog: the
                                                seller already opted in by typing a
                                                contact into the listing, and a modal
                                                between them and a "yes" is friction
                                                pointed the wrong way. */}
                                            {iq.status === 'PENDING' && (
                                                <p className="text-xs text-content-muted">{t('acceptSharesContact')}</p>
                                            )}

                                            {/* The other half of the exchange: the
                                                buyer's contact, once this seller has
                                                accepted. Same gate, mirrored. */}
                                            {iq.contactSharedAt != null && (
                                                <div className="space-y-tight rounded-lg border border-border-emphasis bg-bg-subtle p-3">
                                                    <p className="text-sm font-medium text-content-emphasis">{t('contactHeading')}</p>
                                                    {iq.counterpartyContact ? (
                                                        <CopyText
                                                            value={iq.counterpartyContact}
                                                            label={t('contactCopyLabel')}
                                                            className="text-base font-medium text-content-emphasis"
                                                        >
                                                            {iq.counterpartyContact}
                                                        </CopyText>
                                                    ) : (
                                                        <p className="text-sm text-content-muted">{t('contactMissing')}</p>
                                                    )}
                                                </div>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <p className="border-t border-border-subtle pt-default text-xs text-content-muted">{t('inquiriesEmpty')}</p>
                            )}
                        </div>
                    )))}
                </div>
            </ListPageShell.Body>
        </ListPageShell>
        {confirm && (
            <ConfirmDialog
                showModal
                setShowModal={() => setConfirm(null)}
                tone={confirm.tone}
                title={confirm.title}
                description={confirm.description}
                confirmLabel={confirm.confirmLabel}
                onConfirm={async () => { await confirm.action(); setConfirm(null); }}
            />
        )}
        </>
    );
}
