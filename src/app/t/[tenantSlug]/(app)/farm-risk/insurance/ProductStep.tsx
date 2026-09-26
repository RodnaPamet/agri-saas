'use client';

/**
 * Step 1 — what the farmer wants to insure.
 *
 * Crop or weather risk, then one product from that group. Splitting the two
 * keeps each radio group at 5 or 3 options rather than one list of 8, which is
 * what Epic 55's 2-5 rule is about.
 */
import { useTranslations } from 'next-intl';
import { FormField } from '@/components/ui/form-field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { INSURANCE_PRODUCTS, type InsuranceProductKey } from '@/lib/insurance';
import type { ProductKind } from './useInsuranceQuote';

export function ProductStep({
    kind,
    productKey,
    onKind,
    onProduct,
}: {
    kind: ProductKind;
    productKey: InsuranceProductKey | null;
    onKind: (kind: ProductKind) => void;
    onProduct: (key: InsuranceProductKey) => void;
}) {
    const t = useTranslations('ag.risk.quote');
    const tp = useTranslations('insurance.products');
    const inKind = INSURANCE_PRODUCTS.filter((p) => p.kind === kind);

    return (
        <div className="space-y-default">
            {/* ToggleGroup takes no `id` of its own (only its options do), so the
                stable E2E handle sits on the wrapper. */}
            <div id="insurance-quote-kind">
                <ToggleGroup
                    // ToggleGroup defaults its radiogroup label to the English
                    // "Options", so a translated one is not optional.
                    ariaLabel={t('kindLabel')}
                    options={[
                        { value: 'crop', label: t('kindCrop'), id: 'insurance-quote-kind-crop' },
                        { value: 'peril', label: t('kindPeril'), id: 'insurance-quote-kind-peril' },
                    ]}
                    selected={kind}
                    selectAction={(v) => onKind(v as ProductKind)}
                />
            </div>
            <FormField label={t('productLabel')} required>
                <RadioGroup
                    id="insurance-quote-product"
                    aria-label={t('productLabel')}
                    value={productKey ?? ''}
                    onValueChange={(v) => onProduct(v as InsuranceProductKey)}
                >
                    {inKind.map((p) => (
                        <label
                            key={p.key}
                            className="flex cursor-pointer items-start gap-compact rounded-lg border border-border-subtle p-3 text-sm"
                        >
                            <RadioGroupItem value={p.key} id={`insurance-quote-product-${p.key}`} />
                            <span>
                                <span className="block font-medium text-content-emphasis">
                                    {tp(`${p.key}.name`)}
                                </span>
                                <span className="block text-xs text-content-muted">
                                    {tp(`${p.key}.blurb`)}
                                </span>
                            </span>
                        </label>
                    ))}
                </RadioGroup>
            </FormField>
        </div>
    );
}
