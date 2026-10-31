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
 *
 * ── It CREATES and it EDITS, from one form — #2543 ───────────────────────
 *
 * `OfferModal` takes a discriminated `mode`; `CreateOfferModal` is a thin
 * wrapper over the create arm. The PUT's body is the POST's body plus
 * `updatedAt`, so a second form would be eleven fields duplicated with
 * nothing keeping them in step — and the field this form is most careful
 * about (`sellerContact`, private; `publishAsFarm`, flag-gated and
 * consent-bearing) are exactly the ones a drifting copy would get wrong.
 *
 * It stays in THIS FILE rather than being extracted to a shared
 * `OfferFormFields`, and that is deliberate: three guards read this path as a
 * hardcoded string — `input-commodity-invariants` (the commodity Combobox is
 * derived, never free text), `oblast-comes-from-the-region-list` (regionCode
 * comes from the oblast list) and `p6-controls-are-flag-gated` (the
 * `publishAsFarm` switch is gated on `social.public-profile`). Moving the
 * fields out would point all three at a file that no longer contains what
 * they assert. They would fail loudly rather than pass vacuously, which is
 * the better direction — but the form being one file is what makes create and
 * edit unable to disagree, so the extraction has no upside to pay for it.
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
import { Switch } from '@/components/ui/switch';
import { apiPost, apiPut } from '@/lib/api-client';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { BULGARIA_REGION_OPTIONS } from '@/lib/geo/bulgaria-regions';
import { CANONICAL_COMMODITIES } from '@/lib/market/commodity-vocabulary';
import { EXCHANGE_CURRENCY } from '@/lib/exchange/currency';
import type {
    ExchangeKindValue,
    ExchangeListingEdit,
    ExchangePublicListing,
} from '@/lib/exchange/public-listing';
import { commodityLabel, type CommodityTranslator } from '@/lib/market/commodity-label';

/**
 * Offered commodities, DERIVED from the canonical vocabulary.
 *
 * This used to be a hand-maintained Title-Case list. The write schema now
 * normalises to the canonical slugs, so a hardcoded list could drift into
 * offering an option the API rejects — the worst kind of form, one that
 * fails only after the user has filled everything in. Deriving makes the
 * two agree by construction.
 *
 * The submitted VALUE is the canonical slug; the label is Title-Cased for
 * display, which is what the hardcoded list rendered anyway.
 */
/**
 * Built per-render rather than at module scope, because the label is now
 * LOCALISED and a module constant would freeze one language into the bundle.
 * The VALUE is still the canonical slug — only the label moves.
 */
function buildCommodityOptions(tCommodity: CommodityTranslator): ComboboxOption[] {
    return CANONICAL_COMMODITIES.map((slug) => ({
        value: slug,
        label: commodityLabel(tCommodity, slug),
    })).sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Create a listing, or replace one that exists.
 *
 * A DISCRIMINATED union rather than an optional `listingId` beside an optional
 * `onSaved`: each mode needs a different callback and a different request, and
 * optional props would let a call site ask for an edit with no row to edit.
 * This makes that combination unrepresentable.
 */
export type OfferModalMode =
    | { kind: 'create'; onCreated: (listing: ExchangePublicListing) => void }
    | {
          kind: 'edit';
          listingId: string;
          /**
           * The row's editable values AS STORED — the `edit` object from
           * `GET /exchange/my-listings`, which is this form's body verbatim.
           *
           * Read ONCE, in the `useState` initialisers below, so the caller
           * must mount a fresh modal per listing (`key={listing.id}`). That is
           * why there is no `useEffect` re-seeding form state from props: an
           * effect that calls setState is both a lint finding here and a race
           * with whatever the operator has already typed.
           */
          initial: ExchangeListingEdit;
          onSaved: (listing: ExchangePublicListing) => void;
      };

interface OfferModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    mode: OfferModalMode;
    /**
     * Whether `social.public-profile` is on FOR THIS VIEWER — P6.7 (#1929).
     *
     * REQUIRED, not optional with a default. An optional flag prop defaults to
     * one value or the other, and whichever that is would be the wrong answer
     * somewhere: `false` silently hides the control from a farm entitled to
     * it, `true` restores exactly the defect this fixes. A required prop makes
     * every call site say which it means.
     */
    publicProfileEnabled: boolean;
}

// `defaultSellerName` is gone. It existed only to fill a hint that promised a
// blank field would publish the farm's own name — behaviour nothing
// implemented, and no caller ever passed the prop, so the promise was made to
// every seller and kept for none.
export function OfferModal({
    open,
    setOpen,
    mode,
    publicProfileEnabled,
}: OfferModalProps) {
    const t = useTranslations('exchange.offer');
    const buildUrl = useTenantApiUrl();

    const editing = mode.kind === 'edit' ? mode : null;
    const initial = editing?.initial ?? null;

    const [side, setSide] = useState<'SELL' | 'BUY'>(initial?.side ?? 'SELL');
    const [kind, setKind] = useState<ExchangeKindValue>(initial?.kind ?? 'CULTURE');
    const [commodity, setCommodity] = useState(initial?.commodity ?? '');
    const [quantity, setQuantity] = useState(initial?.quantityTonnes ?? '');
    const [price, setPrice] = useState(initial?.pricePerTonne ?? '');
    const [regionCode, setRegionCode] = useState(initial?.regionCode ?? '');
    const [description, setDescription] = useState(initial?.description ?? '');
    const [expiresAt, setExpiresAt] = useState<Date | null>(
        initial?.expiresAt ? new Date(initial.expiresAt) : null,
    );
    const [displayName, setDisplayName] = useState(initial?.sellerDisplayName ?? '');
    const [publishAsFarm, setPublishAsFarm] = useState(initial?.publishAsFarm ?? false);
    const [sellerContact, setSellerContact] = useState(initial?.sellerContact ?? '');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const tCommodity = useTranslations('trends.commodities');
    const commodityOptions = useMemo(
        () => buildCommodityOptions(tCommodity),
        [tCommodity],
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

    /**
     * What to send for `expiresAt`.
     *
     * UNCHANGED means the STORED STRING, byte for byte. The server accepts an
     * unchanged expiry whatever the clock says and refuses only a CHANGED one
     * that is in the past — otherwise editing a listing on its last day would
     * be refused over a field nobody touched. It compares instants, so a
     * re-serialised equal date would also pass; sending the original is what
     * the operation's own description says a client does, and it keeps this
     * form and the iOS one literally identical on the one field where
     * "identical" is load-bearing.
     */
    function expiryToSend(): string | null {
        if (!expiresAt) return null;
        if (initial?.expiresAt && new Date(initial.expiresAt).getTime() === expiresAt.getTime()) {
            return initial.expiresAt;
        }
        return expiresAt.toISOString();
    }

    /**
     * The request body — the SAME eleven fields for both modes, because the
     * PUT's shape is the POST's plus `updatedAt`. Built in one place so a mode
     * cannot acquire a field the other lacks.
     */
    function payload() {
        return {
            side,
            kind,
            commodity: commodity.trim(),
            quantityTonnes: quantity.trim(),
            pricePerTonne: price.trim() === '' ? null : price.trim(),
            // No currency field: the marketplace is euro-denominated, so
            // there is nothing to choose. Sending it explicitly keeps the
            // request self-describing for anyone reading the network tab.
            priceCurrency: EXCHANGE_CURRENCY,
            regionCode,
            description: description.trim() === '' ? null : description.trim(),
            sellerDisplayName: displayName.trim() === '' ? null : displayName.trim(),
            publishAsFarm,
            // PRIVATE, unlike every other field on this form. It is not in
            // `ExchangePublicListing`, so the response we get back never
            // echoes it — it surfaces once, to one buyer, on accept.
            sellerContact: sellerContact.trim() === '' ? null : sellerContact.trim(),
            expiresAt: expiryToSend(),
        };
    }

    /**
     * The stored values put through `payload()`'s own normalisation, so
     * "dirty" compares like with like. Without the round-trip a stored `null`
     * description and an empty input would read as a change, and the modal
     * would warn about unsaved work on a form nobody edited.
     */
    const storedPayload = useMemo(
        () =>
            initial
                ? JSON.stringify({
                      side: initial.side,
                      kind: initial.kind,
                      commodity: initial.commodity.trim(),
                      quantityTonnes: initial.quantityTonnes.trim(),
                      pricePerTonne:
                          (initial.pricePerTonne ?? '').trim() === ''
                              ? null
                              : (initial.pricePerTonne ?? '').trim(),
                      priceCurrency: EXCHANGE_CURRENCY,
                      regionCode: initial.regionCode,
                      description:
                          (initial.description ?? '').trim() === ''
                              ? null
                              : (initial.description ?? '').trim(),
                      sellerDisplayName:
                          (initial.sellerDisplayName ?? '').trim() === ''
                              ? null
                              : (initial.sellerDisplayName ?? '').trim(),
                      publishAsFarm: initial.publishAsFarm,
                      sellerContact:
                          (initial.sellerContact ?? '').trim() === ''
                              ? null
                              : (initial.sellerContact ?? '').trim(),
                      expiresAt: initial.expiresAt,
                  })
                : null,
        [initial],
    );

    const isDirty = editing
        ? JSON.stringify(payload()) !== storedPayload
        : commodity !== '' || regionCode !== '' || quantity !== '' || price !== '' ||
          description !== '' || displayName !== '' || sellerContact !== '' || expiresAt !== null || publishAsFarm;

    function reset() {
        setSide('SELL'); setKind('CULTURE'); setCommodity(''); setQuantity('');
        setPrice(''); setRegionCode(''); setDescription('');
        setExpiresAt(null); setDisplayName(''); setSellerContact(''); setError(null);
    }

    async function submit() {
        setSubmitting(true);
        setError(null);
        try {
            if (editing) {
                const saved = await apiPut<ExchangePublicListing>(
                    buildUrl(`/exchange/listings/${editing.listingId}`),
                    {
                        ...payload(),
                        // A PRECONDITION, not a value. The server refuses with
                        // 409 LISTING_MODIFIED when it no longer matches, so a
                        // concurrent edit is rejected rather than silently
                        // overwritten — which is the whole reason this is a
                        // replacement the operator can be trusted with.
                        updatedAt: editing.initial.updatedAt,
                    },
                );
                editing.onSaved(saved);
                setOpen(false);
                // NOT reset(). The modal is mounted per listing and unmounts
                // on close, so there is no stale state to clear — and
                // blanking the form before the close animation finishes shows
                // the operator an empty version of what they just saved.
                return;
            }
            const created = await apiPost<ExchangePublicListing>(buildUrl('/exchange/listings'), payload());
            mode.onCreated(created);
            setOpen(false);
            reset();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to save offer');
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <Modal
            showModal={open}
            setShowModal={setOpen}
            size="lg"
            title={editing ? t('editTitle') : t('title')}
            description={t('description')}
            preventDefaultClose={submitting}
            isDirty={isDirty}
        >
            <Modal.Header
                title={editing ? t('editTitle') : t('title')}
                description={editing ? t('editHeaderDescription') : t('headerDescription')}
            />
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

                        {/* No `onCreate`. It used to let a seller invent a
                            commodity, and free text is exactly what killed the
                            own-listings index: every spelling became its own
                            group, fragmenting real groups below the k-anonymity
                            floor until they vanished, and none of them could
                            ever join to the lowercase MarketPriceSeries slug.
                            The write schema now normalises to the canonical
                            vocabulary, so offering a create affordance would
                            only produce a 400 after the form is filled in.
                            Adding a commodity is a deliberate edit to
                            CANONICAL_COMMODITIES. */}
                        <FormField label={t('commodity')} required>
                            <Combobox
                                id="exchange-commodity"
                                options={commodityOptions}
                                selected={commodityOptions.find((o) => o.value === commodity) ?? null}
                                setSelected={(o) => setCommodity(o?.value ?? '')}
                                placeholder={t('commodityPlaceholder')}
                                searchPlaceholder={t('searchPlaceholder')}
                                matchTriggerWidth
                            />
                        </FormField>

                        {/* No currency picker. The marketplace is
                            euro-denominated, so offering a choice would only
                            reintroduce the defect this PR closed: prices that
                            cannot be compared with the offer next to them. The
                            unit rides on the price label instead. */}
                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <FormField label={t('quantity')} required>
                                <Input id="exchange-qty" inputMode="decimal" autoComplete="off" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder={t('quantityPlaceholder')} />
                            </FormField>
                            <FormField label={t('price')} hint={side === 'BUY' ? t('priceHintBuy') : t('priceHint')}>
                                <Input id="exchange-price" inputMode="decimal" autoComplete="off" value={price} onChange={(e) => setPrice(e.target.value)} placeholder={t('pricePlaceholder')} />
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
                            {/* The hint used to promise that a blank name would
                                publish the farm's own name. It never did — the
                                server stores null and every surface renders
                                "Anonymous farm". `description`, not `hint`, so
                                a statement about what strangers will see is
                                read rather than hovered. */}
                            <FormField label={t('sellerName')} description={t('sellerNameConsent')}>
                                <Input id="exchange-seller-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={t('sellerNamePlaceholder')} maxLength={120} />
                            </FormField>
                            {/* Publish AS THE FARM — P6.7 (#1816).
                                `description`, like its two neighbours, because
                                a statement about what strangers will see has to
                                be read rather than hovered.

                                Offered unconditionally, and the copy carries
                                the condition instead of the control. Knowing
                                whether this farm's page is public needs
                                `GET /farm-brand`, which is ADMIN-gated — a
                                member who can post a listing may not be able
                                to read it — so a disabled switch would be
                                disabled for the wrong people. The server is
                                lenient for the matching reason: the flag is
                                saved either way and starts showing the moment
                                the page is published, so the ORDER of two
                                unrelated decisions never matters. */}
                            {/* GATED on `social.public-profile` — P6.7 (#1929).
                                Not rendered at all, rather than disabled.

                                With the flag off this switch cannot do
                                anything: `/farm-brand/publication` 404s for
                                the caller, and `/f/{handle}` checks the flag
                                globally, so a ticked switch attributes nothing
                                and the link its consent text promises («…с
                                връзка към страницата му…») cannot open. A
                                control that silently does nothing is worse
                                than an absent one, and this one asks for
                                CONSENT to a thing that will not happen.

                                Absent rather than disabled for the reason
                                `assertFeatureEnabled` 404s rather than 403s: a
                                dark-launched surface should not be
                                discoverable, and a greyed-out switch
                                advertises it. */}
                            {publicProfileEnabled ? (
                                <FormField
                                    label={t('publishAsFarm')}
                                    description={t('publishAsFarmConsent')}
                                >
                                    <Switch
                                        id="exchange-publish-as-farm"
                                        checked={publishAsFarm}
                                        onCheckedChange={setPublishAsFarm}
                                    />
                                </FormField>
                            ) : null}
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
                        {editing ? t('editSubmit') : t('submit')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}

interface CreateOfferModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    onCreated: (listing: ExchangePublicListing) => void;
    publicProfileEnabled: boolean;
}

/**
 * The create entry point, kept as its own export so `ExchangeClient` reads the
 * same as it did and nothing about publishing a new offer changed. The edit
 * arm is reached through `OfferModal` directly.
 */
export function CreateOfferModal({
    open,
    setOpen,
    onCreated,
    publicProfileEnabled,
}: CreateOfferModalProps) {
    return (
        <OfferModal
            open={open}
            setOpen={setOpen}
            mode={{ kind: 'create', onCreated }}
            publicProfileEnabled={publicProfileEnabled}
        />
    );
}
