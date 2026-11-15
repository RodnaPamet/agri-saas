/**
 * #3063 — what the three new card kinds SAY, composed by the reader.
 *
 * `composeCardText` is where a card's sentence is built, because
 * `cardPayloadJson` holds facts and one channel is read in both languages: a
 * sentence composed at generation time would pick a language for every future
 * reader. So these cases assert the composition, and the generators' own
 * suite asserts the facts.
 *
 * The copy here is IDENTIFIABLE rather than real — `t('x')` style stubs — so
 * a failure names the key that moved instead of the Bulgarian sentence that
 * happens to contain it.
 */
import { composeCardText, CardCopy } from '@/lib/channels/card-text';

const copy: CardCopy = {
    newsHeading: 'NEWS_H',
    newsSource: (v) => `SRC:${v.source}`,
    listingHeading: 'LISTING_H',
    listingLine: (v) => `L:${v.commodity}/${v.quantity}`,
    listingLineWithPrice: (v) => `LP:${v.commodity}/${v.quantity}/${v.price}`,
    schemeHeading: 'SCHEME_H',
    schemeDeadline: (v) => `DL:${v.date}`,
    eventHeading: 'EVENT_H',
    eventWhen: (v) => `WHEN:${v.date}`,
    commodityName: (slug) => `NAME(${slug})`,
    dayLabel: (iso) => `DAY(${iso})`,
};

describe('#3063 — the LISTING card', () => {
    it('resolves the commodity through the CALLER, never the slug', () => {
        const out = composeCardText({
            kind: 'LISTING',
            payload: { commodity: 'wheat', quantityTonnes: '25.000' },
        }, copy);
        expect(out?.senderLabel).toBe('LISTING_H');
        // The whole reason `commodityName` is a resolver the caller supplies:
        // a payload carries `wheat`, and «Пшеница» needs a translator that
        // `card-text.ts` deliberately does not have.
        expect(out?.body).toBe('L:NAME(wheat)/25.000');
    });

    it('uses the WITH-PRICE sentence when there is a price, not an empty slot', () => {
        const out = composeCardText({
            kind: 'LISTING',
            payload: {
                commodity: 'maize', quantityTonnes: '10.500',
                pricePerTonne: '215.12', priceCurrency: 'EUR',
            },
        }, copy);
        // Two sentences rather than one with a hole: the interpolator is
        // plain, so an absent price would render a dangling separator or the
        // literal placeholder.
        expect(out?.body).toBe('LP:NAME(maize)/10.500/215.12 EUR');
    });

    it('falls back to the no-price sentence when the currency is missing', () => {
        const out = composeCardText({
            kind: 'LISTING',
            payload: {
                commodity: 'barley', quantityTonnes: '4.000', pricePerTonne: '180.00',
            },
        }, copy);
        // A price with no currency is not a price anybody can act on.
        expect(out?.body).toBe('L:NAME(barley)/4.000');
    });

    it('returns null without a commodity or a quantity', () => {
        // The NEWS arm's rule: a line with a blank where the crop goes reads
        // as a broken post, and the caller falls back to the server `body` —
        // the seller's own description when there is one.
        expect(composeCardText({ kind: 'LISTING', payload: { quantityTonnes: '1' } }, copy))
            .toBeNull();
        expect(composeCardText({ kind: 'LISTING', payload: { commodity: 'wheat' } }, copy))
            .toBeNull();
        expect(composeCardText({ kind: 'LISTING', payload: null }, copy)).toBeNull();
    });

    it('REFUSES a numeric quantity, rather than rendering it', () => {
        // The generators write Decimal columns as STRINGS because money and
        // tonnages never pass through a float here. A payload carrying a JSON
        // number has already lost that guarantee, and rendering it would hide
        // that the writer stopped honouring it.
        const out = composeCardText({
            kind: 'LISTING',
            payload: { commodity: 'wheat', quantityTonnes: 25 },
        }, copy);
        expect(out).toBeNull();
    });
});

describe('#3063 — the SCHEME card', () => {
    it('leads with the title and follows with the deadline', () => {
        const out = composeCardText({
            kind: 'SCHEME',
            payload: { title: 'Мярка 4.1', closesOn: '2026-12-01' },
        }, copy);
        expect(out?.senderLabel).toBe('SCHEME_H');
        expect(out?.body).toBe('Мярка 4.1\n\nDL:DAY(2026-12-01)');
    });

    it('shows the title ALONE when no deadline is stated', () => {
        // The common case for an announcement — and «Краен срок:» with
        // nothing after it would read as a missing date rather than an
        // open-ended scheme.
        const out = composeCardText({
            kind: 'SCHEME', payload: { title: 'Мярка 4.1' },
        }, copy);
        expect(out?.body).toBe('Мярка 4.1');
    });

    it('returns null without a title', () => {
        expect(composeCardText({ kind: 'SCHEME', payload: { closesOn: '2026-12-01' } }, copy))
            .toBeNull();
    });
});

describe('#3063 — the EVENT card', () => {
    it('leads with the title and follows with the start', () => {
        const out = composeCardText({
            kind: 'EVENT',
            payload: { title: 'Агра 2027', startsAt: '2027-02-24T08:00:00.000Z' },
        }, copy);
        expect(out?.senderLabel).toBe('EVENT_H');
        expect(out?.body).toBe('Агра 2027\n\nWHEN:DAY(2027-02-24T08:00:00.000Z)');
    });

    it('returns null without a title', () => {
        expect(composeCardText({ kind: 'EVENT', payload: { startsAt: 'x' } }, copy))
            .toBeNull();
    });
});

describe('#3063 — an unknown kind still falls through', () => {
    it('returns null rather than throwing', () => {
        // The `StreamEventKind` rule, unchanged by adding three kinds: a
        // client one release behind meets a kind it does not know, and the
        // caller's fallback is the server's plain-text body.
        expect(composeCardText({ kind: 'WEATHER', payload: { title: 'x' } }, copy))
            .toBeNull();
    });

    it('NEWS is untouched by the three additions', () => {
        const out = composeCardText({
            kind: 'NEWS', payload: { title: 'Заглавие', source: 'Агри.бг' },
        }, copy);
        expect(out).toEqual({ senderLabel: 'NEWS_H', body: 'Заглавие\n\nSRC:Агри.бг' });
    });
});
