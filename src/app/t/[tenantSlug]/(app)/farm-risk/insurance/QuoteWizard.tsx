'use client';

/**
 * The three-step insurance calculator, opened straight from the per-parcel
 * button on Farm risk. No page, no nav entry, nothing between the tap and
 * step 1.
 *
 * The premium shown here is a PREVIEW. The server recomputes it from the same
 * tariff table and its answer is what gets recorded — so when the two differ
 * (a cached PWA bundle against a newer tariff, which is a real situation on an
 * installed app) the toast reports the SERVER's figure, not this one.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { z } from 'zod';
import { StepWizard, type StepWizardStep } from '@/components/ui/step-wizard';
import { useIsOnline } from '@/components/ui/async-state';
import { useToast } from '@/components/ui/hooks';
import { apiPost } from '@/lib/api-client';
import { useTenantApiUrl, useTenantCurrencySymbol } from '@/lib/tenant-context-provider';
import { haToDca, trimNumber } from '@/lib/agro/rate-calc';
import { formatCents, getProduct, sumCropArea, type CropAreaParcel } from '@/lib/insurance';
import { CoverStep } from './CoverStep';
import { PaymentStep } from './PaymentStep';
import { ProductStep } from './ProductStep';
import { useInsuranceQuote } from './useInsuranceQuote';

/** What the route answers with. Validated in dev by `apiPost`. */
const LeadResponse = z.object({
    id: z.string(),
    status: z.string().optional(),
    quote: z
        .object({
            premiumCents: z.number(),
            instalmentsCents: z.array(z.number()),
            tariffBp: z.number(),
            engineVersion: z.number(),
        })
        .optional(),
});

export interface QuoteWizardProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    parcelId: string;
    locationId: string;
    /** The parcel's display name — the wizard's accessible title. */
    parcelName: string;
    /** Null when the satellite read never loaded; the calculator does not use it. */
    risk: { overall: string; ndvi: number | null; ndmi: number | null } | null;
    cropType?: string | null;
    areaHa?: number | null;
    /** The selected location's name, for the crop-aggregate chip's label. */
    locationName?: string | null;
    /**
     * Every parcel at this location. The chip sums the ones sharing this
     * parcel's crop — the read behind it has no LIMIT, so the sum is the whole
     * location rather than a page of it.
     */
    locationParcels?: readonly CropAreaParcel[];
    onRequested?: () => void;
}

export function QuoteWizard({
    open,
    onOpenChange,
    parcelId,
    locationId,
    parcelName,
    risk,
    cropType,
    areaHa,
    locationName,
    locationParcels,
    onRequested,
}: QuoteWizardProps) {
    const t = useTranslations('ag.risk.quote');
    const tAsk = useTranslations('ag.risk.ask');
    const tProducts = useTranslations('insurance.products');
    const buildUrl = useTenantApiUrl();
    const symbol = useTenantCurrencySymbol();
    const toast = useToast();
    const online = useIsOnline();
    const q = useInsuranceQuote({ cropType, areaHa });
    const [error, setError] = useState<string | null>(null);

    const { state, areaDca, sumInsuredCents, counterpartCents, quote, tariffBp } = q;
    const ok = quote?.ok === true ? quote : null;

    // A refusal names the field to fix, so the message goes ON that field.
    const refusal = quote && !quote.ok ? quote.reason : null;
    const areaError =
        refusal === 'area' || (state.areaRaw.trim() !== '' && areaDca == null)
            ? t('refusalArea')
            : undefined;
    const sumError =
        refusal === 'sumInsured' || (state.sumRaw.trim() !== '' && sumInsuredCents == null)
            ? t('refusalSumInsured')
            : undefined;
    // Neither of these is reachable from the two fields on this step, so they
    // belong in the wizard's error slot rather than on a field.
    const stepError =
        refusal === 'tariff'
            ? t('refusalTariff')
            : refusal === 'instalments'
              ? t('refusalInstalments')
              : null;

    /** This parcel's own prefilled area, rounded the way the field shows it. */
    const parcelAreaDca = areaHa == null ? null : Math.round(haToDca(areaHa) * 100) / 100;

    const cropTotal = useMemo(() => {
        if (!state.productKey || !locationParcels?.length) return null;
        // Peril products match no crop, so the aggregate is empty for them and
        // the chip never appears — no separate kind check needed.
        if (getProduct(state.productKey)?.kind !== 'crop') return null;
        const total = sumCropArea(locationParcels, state.productKey);
        // Two or more parcels, and a figure that actually differs from this
        // parcel's own — otherwise the chip offers what the field already holds.
        if (total.parcelCount < 2) return null;
        if (parcelAreaDca != null && total.areaDca === parcelAreaDca) return null;
        return total;
    }, [state.productKey, locationParcels, parcelAreaDca]);

    const cropChip = useMemo(() => {
        if (!cropTotal || !state.productKey) return null;
        return {
            areaDca: cropTotal.areaDca,
            label: t('cropChip', {
                product: tProducts(`${state.productKey}.name`),
                location: locationName ?? '',
                area: trimNumber(cropTotal.areaDca),
                count: cropTotal.parcelCount,
            }),
        };
    }, [cropTotal, state.productKey, locationName, t, tProducts]);

    /**
     * DERIVED from the value at send time, never tracked through events — so it
     * cannot claim "all your wheat" over a figure the farmer has since edited.
     */
    const areaScope: 'parcel' | 'crop-at-location' | 'custom' =
        areaDca != null && parcelAreaDca != null && areaDca === parcelAreaDca
            ? 'parcel'
            : areaDca != null && cropTotal != null && areaDca === cropTotal.areaDca
              ? 'crop-at-location'
              : 'custom';

    const premiumText = ok
        ? t('premiumLine', {
              premium: formatCents(ok.premiumCents, symbol),
              perDca: formatCents(ok.premiumPerDcaCents, symbol),
          })
        : null;

    async function send() {
        setError(null);
        const key = q.idempotencyKey();
        try {
            const res = await apiPost(
                buildUrl('/insurance/leads'),
                {
                    parcelId,
                    locationId,
                    risk,
                    quote: {
                        productKey: state.productKey,
                        areaDca,
                        sumInsuredCents,
                        instalments: state.instalments,
                        areaScope,
                        // Only meaningful for the crop-wide scope, and the
                        // server REQUIRES it there.
                        ...(areaScope === 'crop-at-location' && cropTotal
                            ? { coveredParcelCount: cropTotal.parcelCount }
                            : {}),
                    },
                    message: state.note.trim() || undefined,
                },
                LeadResponse,
                {
                    // `apiPost` spreads `init` AFTER its own headers, so a
                    // headers object here REPLACES Content-Type rather than
                    // merging with it. Both must be named.
                    headers: {
                        'Content-Type': 'application/json',
                        'Idempotency-Key': key,
                    },
                },
            );
            const server = res.quote?.premiumCents;
            toast.success(
                server != null && ok != null && server !== ok.premiumCents
                    ? t('serverPremium', { premium: formatCents(server, symbol) })
                    : tAsk('sentToast'),
            );
            onRequested?.();
        } catch (err) {
            setError(err instanceof Error ? err.message : tAsk('error'));
            // Rejecting is the wizard's "failed, keep open" signal: it stays on
            // step 3 with every input intact so the farmer can retry. The retry
            // reuses this same key, because the inputs have not changed.
            throw err;
        }
    }

    const steps: StepWizardStep[] = [
        {
            id: 'product',
            title: t('step1Title'),
            canAdvance: state.productKey !== null,
            content: (
                <ProductStep
                    kind={state.kind}
                    productKey={state.productKey}
                    onKind={q.setKind}
                    onProduct={q.setProduct}
                />
            ),
        },
        {
            id: 'cover',
            title: t('step2Title'),
            canAdvance: ok !== null,
            content: (
                <CoverStep
                    areaRaw={state.areaRaw}
                    sumRaw={state.sumRaw}
                    sumMode={state.sumMode}
                    areaDca={areaDca}
                    counterpartCents={counterpartCents}
                    premiumText={premiumText}
                    areaError={areaError}
                    sumError={sumError}
                    symbol={symbol}
                    autoFocusArea={areaHa == null}
                    cropChip={cropChip}
                    onUseCropChip={() => {
                        if (cropChip) q.setArea(trimNumber(cropChip.areaDca));
                    }}
                    onArea={q.setArea}
                    onSum={q.setSum}
                    onSumMode={q.setSumMode}
                />
            ),
        },
        {
            id: 'payment',
            title: t('step3Title'),
            // Offline blocks SENDING only — every figure above still computes.
            canAdvance: ok !== null && online,
            content:
                ok && tariffBp != null && areaDca != null && sumInsuredCents != null ? (
                    <PaymentStep
                        premiumCents={ok.premiumCents}
                        premiumPerDcaCents={ok.premiumPerDcaCents}
                        instalmentsCents={ok.instalmentsCents}
                        instalments={state.instalments}
                        sumInsuredCents={sumInsuredCents}
                        tariffBp={tariffBp}
                        areaDca={areaDca}
                        note={state.note}
                        symbol={symbol}
                        offline={!online}
                        onInstalments={q.setInstalments}
                        onNote={q.setNote}
                    />
                ) : null,
        },
    ];

    return (
        <StepWizard
            open={open}
            onOpenChange={onOpenChange}
            title={parcelName}
            steps={steps}
            onFinish={send}
            finishLabel={tAsk('submit')}
            isDirty={state.sumRaw !== '' || state.note !== ''}
            error={error ?? stepError}
        />
    );
}
