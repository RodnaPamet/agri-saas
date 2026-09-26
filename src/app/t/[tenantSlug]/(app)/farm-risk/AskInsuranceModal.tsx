'use client';

/**
 * The per-parcel insurance entry point on Farm risk (#13, calculator in #1119).
 *
 * This file is the TRIGGER and the "already asked" state; the three-step
 * calculator it opens lives in `./insurance/QuoteWizard`. One tap goes straight
 * to step 1 — there is deliberately no message box or confirmation in between,
 * because the thing the farmer came for is a price.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { QuoteWizard } from './insurance/QuoteWizard';
import type { CropAreaParcel } from '@/lib/insurance';

interface AskInsuranceModalProps {
    parcelId: string;
    locationId: string;
    /** The parcel's display name — the calculator's accessible title. */
    parcelName: string;
    /**
     * The satellite snapshot, or NULL when the read failed or is still in
     * flight. The calculator does not use the reading, so the button stays
     * available either way: a cloudy week over Sentinel should not cost the
     * farmer a quote.
     */
    risk: { overall: string; ndvi: number | null; ndmi: number | null } | null;
    /** Preselects the product. Free text from seed data ("Winter Wheat"). */
    cropType?: string | null;
    /** Prefills the area, in HECTARES; the calculator converts to decares. */
    areaHa?: number | null;
    /** The location's name, for the crop-aggregate chip (#1121). */
    locationName?: string | null;
    /** Every parcel at this location, for that aggregate. */
    locationParcels?: readonly CropAreaParcel[];
    /**
     * Server-read: has this tenant already requested a quote for this parcel?
     *
     * The durable half. `justSent` below is the optimistic half and is
     * deliberately NOT the source of truth — it only bridges the gap until the
     * page-level SWR read refreshes. Before this prop existed the optimistic
     * flag was ALL there was, so navigating away and back re-enabled the
     * button.
     *
     * It gates a NOTE, never the button. A second request is legitimate — the
     * farmer may have the area wrong, or want different cover — and the
     * `@@unique([parcelId, inquirerTenantId])` that once made it a 409 was
     * dropped on 2026-09-24. What replaces it is idempotency on an explicit
     * `Idempotency-Key`, which collapses a RETRY without ever refusing a
     * genuinely new request.
     */
    hasRequested?: boolean;
    /** Refresh the server-read list after a successful send. */
    onRequested?: () => void;
}

export function AskInsuranceModal({
    parcelId,
    locationId,
    parcelName,
    risk,
    cropType,
    areaHa,
    locationName,
    locationParcels,
    hasRequested = false,
    onRequested,
}: AskInsuranceModalProps) {
    const t = useTranslations('ag.risk.ask');
    const [open, setOpen] = useState(false);
    /**
     * Bumped on every open, and used as the wizard's `key`, so each opening gets
     * a FRESH calculator.
     *
     * `QuoteWizard` stays mounted while closed (its `open` is a prop), so
     * without this the reducer's state outlives the drawer: a farmer who typed a
     * sum insured, dismissed, and confirmed "Discard" would find it still there
     * on reopen — while the confirm had just told them their changes would be
     * lost. The modal this replaced cleared its draft on EVERY close path for
     * the same reason; remounting is how that survives the move to a wizard.
     */
    const [session, setSession] = useState(0);
    // Optimistic only — see `hasRequested`. `sent` is the union of the two.
    const [justSent, setJustSent] = useState(false);
    const sent = hasRequested || justSent;

    return (
        <>
            {/*
              * The control stays ACTIVE after a request, because a parcel may
              * now carry several asks. The note sits BESIDE the button rather
              * than replacing it: the farmer should know they have asked
              * before, and still be able to ask again.
              */}
            <span className="inline-flex items-center gap-tight">
                <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    onClick={() => {
                        setSession((n) => n + 1);
                        setOpen(true);
                    }}
                >
                    {sent ? t('askAgain') : t('open')}
                </Button>
                {sent ? (
                    <Tooltip content={t('alreadySent')}>
                        <span className="text-xs text-content-muted" tabIndex={0} role="note">
                            {t('sent')}
                        </span>
                    </Tooltip>
                ) : null}
            </span>
            <QuoteWizard
                key={session}
                open={open}
                onOpenChange={setOpen}
                parcelId={parcelId}
                locationId={locationId}
                parcelName={parcelName}
                risk={risk}
                cropType={cropType}
                areaHa={areaHa}
                locationName={locationName}
                locationParcels={locationParcels}
                onRequested={() => {
                    setJustSent(true);
                    onRequested?.();
                }}
            />
        </>
    );
}
