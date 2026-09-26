'use client';

/**
 * Step 2 — how much land, and for how much.
 *
 * Both fields echo their own interpretation back. That echo is the point, not
 * decoration: "100 000" and "100.000" both mean one hundred thousand here,
 * while an AREA of "12,345" means twelve-and-a-bit decares. The only way a
 * farmer can see which reading they got is to be shown it.
 */
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { trimNumber } from '@/lib/agro/rate-calc';
import { formatCents } from '@/lib/insurance';
import { PremiumLine } from './PremiumLine';
import type { SumMode } from './useInsuranceQuote';

export function CoverStep({
    cropChip,
    onUseCropChip,
    areaRaw,
    sumRaw,
    sumMode,
    areaDca,
    counterpartCents,
    premiumText,
    areaError,
    sumError,
    symbol,
    autoFocusArea,
    onArea,
    onSum,
    onSumMode,
}: {
    /**
     * The "all your wheat here" aggregate, or null when it does not apply —
     * a peril product, a single parcel, or a total that equals this parcel's
     * own area. Composed by the wizard; this step only renders it.
     */
    cropChip: { label: string; areaDca: number } | null;
    onUseCropChip: () => void;
    areaRaw: string;
    sumRaw: string;
    sumMode: SumMode;
    areaDca: number | null;
    counterpartCents: number | null;
    premiumText: string | null;
    areaError?: string;
    sumError?: string;
    symbol: string;
    autoFocusArea: boolean;
    onArea: (raw: string) => void;
    onSum: (raw: string) => void;
    onSumMode: (mode: SumMode) => void;
}) {
    const t = useTranslations('ag.risk.quote');

    return (
        <div className="space-y-default">
            {cropChip ? (
                /*
                 * A farmer insures a CROP, not a parcel: twelve wheat parcels
                 * should be one request. A button rather than a toggle — it
                 * fills the field, and the farmer can still edit afterwards,
                 * which derives as a custom area.
                 */
                <Button
                    id="insurance-quote-crop-chip"
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={onUseCropChip}
                >
                    {cropChip.label}
                </Button>
            ) : null}
            <FormField
                label={t('areaLabel')}
                error={areaError}
                description={areaDca == null ? undefined : t('areaEcho', { dca: trimNumber(areaDca) })}
                required
            >
                <Input
                    id="insurance-quote-area"
                    inputMode="decimal"
                    enterKeyHint="next"
                    autoFocus={autoFocusArea}
                    value={areaRaw}
                    placeholder={t('areaPlaceholder')}
                    onChange={(e) => onArea(e.target.value)}
                />
            </FormField>

            <div className="space-y-tight">
                {/* ToggleGroup takes no `id` of its own — see ProductStep. */}
                <div id="insurance-quote-sum-mode">
                    <ToggleGroup
                        ariaLabel={t('sumModeLabel')}
                        options={[
                            { value: 'total', label: t('sumModeTotal'), id: 'insurance-quote-sum-mode-total' },
                            { value: 'perDca', label: t('sumModePerDca'), id: 'insurance-quote-sum-mode-per-dca' },
                        ]}
                        selected={sumMode}
                        selectAction={(v) => onSumMode(v as SumMode)}
                    />
                </div>
                <FormField
                    label={t('sumLabel')}
                    error={sumError}
                    description={
                        counterpartCents == null
                            ? undefined
                            : sumMode === 'total'
                              ? t('sumEchoPerDca', { amount: formatCents(counterpartCents, symbol) })
                              : t('sumEchoTotal', { amount: formatCents(counterpartCents, symbol) })
                    }
                    required
                >
                    <Input
                        id="insurance-quote-sum"
                        inputMode="decimal"
                        enterKeyHint="next"
                        value={sumRaw}
                        placeholder={t('sumPlaceholder')}
                        onChange={(e) => onSum(e.target.value)}
                    />
                </FormField>
            </div>

            <PremiumLine text={premiumText} />
        </div>
    );
}
