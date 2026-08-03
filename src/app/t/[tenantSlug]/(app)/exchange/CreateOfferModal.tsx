'use client';

/**
 * Create-offer modal — publish a SELL or BUY listing to the Exchange.
 *
 * region is chosen by oblast (Combobox from bulgaria-regions); the server
 * derives regionName/lat/lon from the code. commodity is picked from the
 * canonical catalogue (localized labels, submits the stable KEY) and still
 * accepts a free-text entry (Combobox `onCreate`) stored as the OTHER long
 * tail. Free text (description / sellerDisplayName) is sanitized server-side.
 * On success the parent optimistically adds the new listing to the map + list.
 */
import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker';
import { Button } from '@/components/ui/button';
import { apiPost } from '@/lib/api-client';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useTranslations, useLocale } from 'next-intl';
import { BULGARIA_REGION_OPTIONS } from '@/lib/geo/bulgaria-regions';
import {
    commodityOptions,
    localizedCommodityLabel,
    asExchangeLocale,
    OTHER_COMMODITY_KEY,
} from '@/lib/exchange/commodities';
import type { ExchangePublicListing } from '@/lib/exchange/public-listing';

interface CreateOfferModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    onCreated: (listing: ExchangePublicListing) => void;
}

export function CreateOfferModal({ open, setOpen, onCreated }: CreateOfferModalProps) {
    const t = useTranslations('exchange');
    const locale = asExchangeLocale(useLocale());
    const buildUrl = useTenantApiUrl();

    const [side, setSide] = useState<'SELL' | 'BUY'>('SELL');
    // Canonical key ('WHEAT', … or 'OTHER'); `commodityOther` holds the free
    // text for the OTHER long tail.
    const [commodityKey, setCommodityKey] = useState('');
    const [commodityOther, setCommodityOther] = useState('');
    const [quantity, setQuantity] = useState('');
    const [price, setPrice] = useState('');
    const [currency, setCurrency] = useState('BGN');
    const [regionCode, setRegionCode] = useState('');
    const [description, setDescription] = useState('');
    const [expiresAt, setExpiresAt] = useState<Date | null>(null);
    const [displayName, setDisplayName] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const commodityChoices = useMemo<ComboboxOption[]>(() => {
        const base = commodityOptions(locale);
        // Show the free-text pick as a selectable OTHER option.
        if (commodityKey === OTHER_COMMODITY_KEY && commodityOther) {
            base.push({ value: OTHER_COMMODITY_KEY, label: commodityOther });
        }
        return base;
    }, [locale, commodityKey, commodityOther]);
    const regionOptions = useMemo<ComboboxOption[]>(() => [...BULGARIA_REGION_OPTIONS], []);

    const qtyNum = Number(quantity);
    const commodityChosen =
        commodityKey !== '' && (commodityKey !== OTHER_COMMODITY_KEY || commodityOther.trim().length > 0);
    const canSubmit =
        commodityChosen &&
        regionCode.length > 0 &&
        quantity.trim().length > 0 &&
        Number.isFinite(qtyNum) &&
        qtyNum > 0 &&
        !submitting;

    const isDirty =
        commodityChosen || regionCode !== '' || quantity !== '' || price !== '' ||
        description !== '' || displayName !== '' || expiresAt !== null;

    function reset() {
        setSide('SELL'); setCommodityKey(''); setCommodityOther(''); setQuantity('');
        setPrice(''); setCurrency('BGN'); setRegionCode(''); setDescription('');
        setExpiresAt(null); setDisplayName(''); setError(null);
    }

    async function submit() {
        setSubmitting(true);
        setError(null);
        try {
            // Store a stable English label as the free-text `commodity` (display
            // fallback), and the canonical key for grouping/localization.
            const commodity = localizedCommodityLabel(commodityKey, commodityOther, 'en').trim();
            const created = await apiPost<ExchangePublicListing>(buildUrl('/exchange/listings'), {
                side,
                commodity,
                commodityKey,
                quantityTonnes: quantity.trim(),
                pricePerTonne: price.trim() === '' ? null : price.trim(),
                priceCurrency: currency.trim() || 'BGN',
                regionCode,
                description: description.trim() === '' ? null : description.trim(),
                sellerDisplayName: displayName.trim() === '' ? null : displayName.trim(),
                expiresAt: expiresAt ? expiresAt.toISOString() : null,
            });
            onCreated(created);
            setOpen(false);
            reset();
        } catch (err) {
            setError(err instanceof Error ? err.message : t('create.error'));
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <Modal
            showModal={open}
            setShowModal={setOpen}
            size="lg"
            title={t('create.title')}
            description={t('create.subtitle')}
            preventDefaultClose={submitting}
            isDirty={isDirty}
        >
            <Modal.Header title={t('create.title')} description={t('create.subtitle')} />
            <Modal.Form id="exchange-offer-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
                <Modal.Body>
                    {error && (
                        <div role="alert" className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error">
                            {error}
                        </div>
                    )}
                    <fieldset disabled={submitting} className="m-0 space-y-default border-0 p-0">
                        <FormField label={t('create.side')} required>
                            <RadioGroup
                                value={side}
                                onValueChange={(v) => setSide(v as 'SELL' | 'BUY')}
                                className="flex gap-section"
                            >
                                <label className="flex items-center gap-compact text-sm">
                                    <RadioGroupItem value="SELL" /> {t('side.selling')}
                                </label>
                                <label className="flex items-center gap-compact text-sm">
                                    <RadioGroupItem value="BUY" /> {t('side.buying')}
                                </label>
                            </RadioGroup>
                        </FormField>

                        <FormField label={t('create.commodity')} required>
                            <Combobox
                                id="exchange-commodity"
                                options={commodityChoices}
                                selected={commodityChoices.find((o) => o.value === commodityKey) ?? null}
                                setSelected={(o) => {
                                    setCommodityKey(o?.value ?? '');
                                    if (!o || o.value !== OTHER_COMMODITY_KEY) setCommodityOther('');
                                }}
                                placeholder={t('create.commodityPlaceholder')}
                                searchPlaceholder={t('create.commoditySearch')}
                                matchTriggerWidth
                                onCreate={async (search) => {
                                    const v = search.trim();
                                    if (!v) return false;
                                    setCommodityKey(OTHER_COMMODITY_KEY);
                                    setCommodityOther(v);
                                    return true;
                                }}
                                createLabel={(search) => t('create.commodityCreate', { search: search.trim() })}
                            />
                        </FormField>

                        <div className="grid grid-cols-1 gap-default sm:grid-cols-3">
                            <FormField label={t('create.quantity')} required>
                                <Input id="exchange-qty" inputMode="decimal" autoComplete="off" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder={t('create.quantityPlaceholder')} />
                            </FormField>
                            <FormField label={t('create.price')} hint={side === 'BUY' ? t('create.priceHintBuy') : t('create.priceHint')}>
                                <Input id="exchange-price" inputMode="decimal" autoComplete="off" value={price} onChange={(e) => setPrice(e.target.value)} placeholder={t('create.pricePlaceholder')} />
                            </FormField>
                            <FormField label={t('create.currency')}>
                                <Input id="exchange-currency" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} placeholder="BGN" maxLength={8} />
                            </FormField>
                        </div>

                        <FormField label={t('create.region')} required description={t('create.regionDescription')}>
                            <Combobox
                                id="exchange-region"
                                options={regionOptions}
                                selected={regionOptions.find((o) => o.value === regionCode) ?? null}
                                setSelected={(o) => setRegionCode(o?.value ?? '')}
                                placeholder={t('create.regionPlaceholder')}
                                searchPlaceholder={t('create.regionSearch')}
                                matchTriggerWidth
                            />
                        </FormField>

                        <FormField label={t('create.description')} hint={t('create.descriptionHint')}>
                            <Textarea id="exchange-description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('create.descriptionPlaceholder')} />
                        </FormField>

                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <FormField label={t('create.expires')} hint={t('create.expiresHint')}>
                                <DatePicker id="exchange-expires" className="w-full" value={expiresAt} onChange={setExpiresAt} clearable placeholder={t('create.expiresPlaceholder')} disabledDays={{ before: new Date() }} />
                            </FormField>
                            <FormField label={t('create.sellerName')} hint={t('create.sellerNameHint')}>
                                <Input id="exchange-seller-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={t('create.sellerNamePlaceholder')} maxLength={120} />
                            </FormField>
                        </div>
                    </fieldset>
                </Modal.Body>
                <Modal.Actions>
                    <Button variant="secondary" size="sm" type="button" onClick={() => setOpen(false)} disabled={submitting}>
                        {t('create.cancel')}
                    </Button>
                    <Button variant="primary" size="sm" type="submit" loading={submitting} disabled={!canSubmit}>
                        {t('create.submit')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
