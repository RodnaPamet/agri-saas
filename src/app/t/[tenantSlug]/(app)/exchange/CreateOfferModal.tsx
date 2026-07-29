'use client';

/**
 * Create-offer modal — publish a SELL or BUY listing to the Exchange.
 *
 * region is chosen by oblast (Combobox from bulgaria-regions); the server
 * derives regionName/lat/lon from the code. commodity is a seeded catalogue
 * that also accepts a free-text entry (Combobox `onCreate`). Free text
 * (description / sellerDisplayName / sellerContact) is sanitized server-side.
 * On success the parent optimistically adds the new listing to the map + list.
 *
 * `sellerContact` is the odd one out: every other field here is published to
 * every tenant, that one is published to nobody. It rides along on the listing
 * so a seller can route different offers to different people, and it leaves
 * the server only through `toPublicInquiry`'s reveal gate — to the single
 * buyer whose inquiry this seller accepts.
 */
import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
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
import { BULGARIA_REGION_OPTIONS } from '@/lib/geo/bulgaria-regions';
import type { ExchangePublicListing } from '@/lib/exchange/public-listing';

const COMMODITY_SEED = [
    'Wheat', 'Maize', 'Sunflower', 'Barley', 'Rapeseed',
    'Oats', 'Rye', 'Soybean', 'Peas', 'Lentils',
];

interface CreateOfferModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    /** Fallback public display name (the tenant name) shown in the hint. */
    defaultSellerName?: string;
    onCreated: (listing: ExchangePublicListing) => void;
}

export function CreateOfferModal({ open, setOpen, defaultSellerName, onCreated }: CreateOfferModalProps) {
    const t = useTranslations('exchange.offer');
    const buildUrl = useTenantApiUrl();

    const [side, setSide] = useState<'SELL' | 'BUY'>('SELL');
    const [kind, setKind] = useState<'CULTURE' | 'FERTILIZER' | 'SEEDS' | 'PRODUCT'>('CULTURE');
    const [commodity, setCommodity] = useState('');
    const [commodityExtra, setCommodityExtra] = useState<string[]>([]);
    const [quantity, setQuantity] = useState('');
    const [price, setPrice] = useState('');
    const [currency, setCurrency] = useState('BGN');
    const [regionCode, setRegionCode] = useState('');
    const [description, setDescription] = useState('');
    const [expiresAt, setExpiresAt] = useState<Date | null>(null);
    const [displayName, setDisplayName] = useState('');
    const [sellerContact, setSellerContact] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const commodityOptions = useMemo<ComboboxOption[]>(
        () => [...COMMODITY_SEED, ...commodityExtra].map((c) => ({ value: c, label: c })),
        [commodityExtra],
    );
    const regionOptions = useMemo<ComboboxOption[]>(() => [...BULGARIA_REGION_OPTIONS], []);

    const qtyNum = Number(quantity);
    const canSubmit =
        commodity.trim().length > 0 &&
        regionCode.length > 0 &&
        quantity.trim().length > 0 &&
        Number.isFinite(qtyNum) &&
        qtyNum > 0 &&
        !submitting;

    const isDirty =
        commodity !== '' || regionCode !== '' || quantity !== '' || price !== '' ||
        description !== '' || displayName !== '' || sellerContact !== '' || expiresAt !== null;

    function reset() {
        setSide('SELL'); setKind('CULTURE'); setCommodity(''); setCommodityExtra([]); setQuantity('');
        setPrice(''); setCurrency('BGN'); setRegionCode(''); setDescription('');
        setExpiresAt(null); setDisplayName(''); setSellerContact(''); setError(null);
    }

    async function submit() {
        setSubmitting(true);
        setError(null);
        try {
            const created = await apiPost<ExchangePublicListing>(buildUrl('/exchange/listings'), {
                side,
                kind,
                commodity: commodity.trim(),
                quantityTonnes: quantity.trim(),
                pricePerTonne: price.trim() === '' ? null : price.trim(),
                priceCurrency: currency.trim() || 'BGN',
                regionCode,
                description: description.trim() === '' ? null : description.trim(),
                sellerDisplayName: displayName.trim() === '' ? null : displayName.trim(),
                // PRIVATE, unlike every other field on this form. It is not in
                // `ExchangePublicListing`, so the response we get back never
                // echoes it — it surfaces once, to one buyer, on accept.
                sellerContact: sellerContact.trim() === '' ? null : sellerContact.trim(),
                expiresAt: expiresAt ? expiresAt.toISOString() : null,
            });
            onCreated(created);
            setOpen(false);
            reset();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create offer');
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <Modal
            showModal={open}
            setShowModal={setOpen}
            size="lg"
            title={t('title')}
            description={t('description')}
            preventDefaultClose={submitting}
            isDirty={isDirty}
        >
            <Modal.Header title={t('title')} description={t('headerDescription')} />
            <Modal.Form id="exchange-offer-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
                <Modal.Body>
                    {error && (
                        <div role="alert" className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error">
                            {error}
                        </div>
                    )}
                    <fieldset disabled={submitting} className="m-0 space-y-default border-0 p-0">
                        <FormField label={t('side')} required>
                            <RadioGroup
                                value={side}
                                onValueChange={(v) => setSide(v as 'SELL' | 'BUY')}
                                className="flex gap-section"
                            >
                                <label className="flex items-center gap-compact text-sm">
                                    <RadioGroupItem value="SELL" /> {t('selling')}
                                </label>
                                <label className="flex items-center gap-compact text-sm">
                                    <RadioGroupItem value="BUY" /> {t('buying')}
                                </label>
                            </RadioGroup>
                        </FormField>

                        <FormField label={t('kind')} required>
                            <RadioGroup
                                value={kind}
                                onValueChange={(v) => setKind(v as 'CULTURE' | 'FERTILIZER' | 'SEEDS' | 'PRODUCT')}
                                className="flex flex-wrap gap-section"
                            >
                                <label className="flex items-center gap-compact text-sm">
                                    <RadioGroupItem value="CULTURE" /> {t('kindCulture')}
                                </label>
                                <label className="flex items-center gap-compact text-sm">
                                    <RadioGroupItem value="FERTILIZER" /> {t('kindFertilizer')}
                                </label>
                                <label className="flex items-center gap-compact text-sm">
                                    <RadioGroupItem value="SEEDS" /> {t('kindSeeds')}
                                </label>
                                <label className="flex items-center gap-compact text-sm">
                                    <RadioGroupItem value="PRODUCT" /> {t('kindProduct')}
                                </label>
                            </RadioGroup>
                        </FormField>

                        <FormField label={t('commodity')} required>
                            <Combobox
                                id="exchange-commodity"
                                options={commodityOptions}
                                selected={commodityOptions.find((o) => o.value === commodity) ?? null}
                                setSelected={(o) => setCommodity(o?.value ?? '')}
                                placeholder={t('commodityPlaceholder')}
                                searchPlaceholder={t('searchPlaceholder')}
                                matchTriggerWidth
                                onCreate={async (search) => {
                                    const v = search.trim();
                                    if (!v) return false;
                                    setCommodityExtra((prev) => (prev.includes(v) ? prev : [...prev, v]));
                                    setCommodity(v);
                                    return true;
                                }}
                                createLabel={(search) => t('commodityCreate', { search: search.trim() })}
                            />
                        </FormField>

                        <div className="grid grid-cols-1 gap-default sm:grid-cols-3">
                            <FormField label={t('quantity')} required>
                                <Input id="exchange-qty" inputMode="decimal" autoComplete="off" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder={t('quantityPlaceholder')} />
                            </FormField>
                            <FormField label={t('price')} hint={side === 'BUY' ? t('priceHintBuy') : t('priceHint')}>
                                <Input id="exchange-price" inputMode="decimal" autoComplete="off" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="e.g. 320" />
                            </FormField>
                            <FormField label={t('currency')}>
                                <Input id="exchange-currency" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} placeholder={t('currencyPlaceholder')} maxLength={8} />
                            </FormField>
                        </div>

                        <FormField label={t('region')} required description={t('regionDescription')}>
                            <Combobox
                                id="exchange-region"
                                options={regionOptions}
                                selected={regionOptions.find((o) => o.value === regionCode) ?? null}
                                setSelected={(o) => setRegionCode(o?.value ?? '')}
                                placeholder={t('regionPlaceholder')}
                                searchPlaceholder={t('regionSearchPlaceholder')}
                                matchTriggerWidth
                            />
                        </FormField>

                        <FormField label={t('descriptionLabel')} hint={t('descriptionHint')}>
                            <Textarea id="exchange-description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('descriptionPlaceholder')} />
                        </FormField>

                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <FormField label={t('expires')} hint={t('expiresHint')}>
                                <DatePicker id="exchange-expires" className="w-full" value={expiresAt} onChange={setExpiresAt} clearable placeholder={t('datePlaceholder')} disabledDays={{ before: new Date() }} />
                            </FormField>
                            <FormField label={t('sellerName')} hint={t('sellerNameHint', { name: defaultSellerName || t('yourTenantName') })}>
                                <Input id="exchange-seller-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={defaultSellerName || t('yourFarmName')} maxLength={120} />
                            </FormField>
                        </div>

                        {/* The one PRIVATE field on this form. `description` (not
                            `hint`) because a consent statement has to be read, not
                            hovered — the seller is deciding what a stranger will be
                            able to reach them on. Anonymity survives: leaving the
                            public name blank and filling this in means reachable
                            after a deal, invisible before one. */}
                        <FormField label={t('sellerContact')} description={t('sellerContactConsent')}>
                            <Input
                                id="exchange-seller-contact"
                                autoComplete="off"
                                value={sellerContact}
                                onChange={(e) => setSellerContact(e.target.value)}
                                placeholder={t('sellerContactPlaceholder')}
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
