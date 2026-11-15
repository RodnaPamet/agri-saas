/**
 * A channel card's displayed text, composed from its FACTS by the reader
 * (P9.4, #2938).
 *
 * ## Why composition is the client's job
 *
 * `cardPayloadJson` holds facts and nothing else, because one channel is read
 * in both languages: a sentence composed when the card was generated would
 * pick a language for every future reader. That is the same correction
 * `DueItem.reason` took — a value shown to a recipient must not be a
 * pre-rendered sentence when the recipient's language is not knowable where it
 * is built.
 *
 * ## Why a module and not a function inside the feed client
 *
 * The feed is the first surface to render a card and will not be the last —
 * the permalink page reads the same `ChannelPostView`, and P9.8 gives iOS the
 * same payload. A second spelling of "what a NEWS card says" is how two
 * surfaces come to describe one row differently, which is the #1664 class.
 *
 * ## An unknown kind returns null, deliberately
 *
 * Not a thrown error and not an empty string. A client one release behind the
 * server will meet a kind it does not know, and the caller's fallback is the
 * server's plain-text `body` — the headline. That is the `StreamEventKind`
 * rule: an unknown value is visibly ignored rather than silently dropped.
 */

/**
 * The catalogue strings this composer needs, already resolved for a locale.
 *
 * ## Two RESOLVERS, not just strings, and why they are here
 *
 * `commodityName` and `dayLabel` are supplied by the caller because this
 * module must stay free of translation and formatting. A LISTING payload
 * carries `commodity: "wheat"` and a SCHEME payload carries
 * `closesOn: "2026-12-01"` — both correct as facts and both unreadable as
 * text. Resolving them needs `t` and a locale, which is exactly what the
 * payload design keeps out of generation time.
 *
 * So the composer asks the caller for the two conversions it cannot perform,
 * and the caller wires them to `commodityLabel(t, slug)` and the shared date
 * formatter. The alternative — importing those here — would put a translator
 * inside the module whose whole point is that it holds none.
 */
export interface CardCopy {
    newsHeading: string;
    newsSource: (vars: { source: string }) => string;
    listingHeading: string;
    listingLine: (vars: { commodity: string; quantity: string }) => string;
    listingLineWithPrice: (
        vars: { commodity: string; quantity: string; price: string },
    ) => string;
    schemeHeading: string;
    schemeDeadline: (vars: { date: string }) => string;
    eventHeading: string;
    eventWhen: (vars: { date: string }) => string;
    /** `"wheat"` → «Пшеница». Supplied by the caller — see above. */
    commodityName: (slug: string) => string;
    /** An ISO date or day key → a locale-formatted day. */
    dayLabel: (iso: string) => string;
}

export interface CardView {
    kind: string;
    payload: Record<string, unknown> | null;
}

/** A non-empty string from an unknown payload field, or null. */
function text(payload: Record<string, unknown> | null, key: string): string | null {
    const v = payload?.[key];
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/**
 * A decimal-STRING field, or null.
 *
 * The generators write `quantityTonnes` and `pricePerTonne` as strings
 * because they are `Decimal` columns and this repo's rule is that money and
 * tonnages never pass through a float. So this accepts a string and
 * deliberately does NOT accept a number: a payload carrying `150.5` as a JSON
 * number has already lost the guarantee, and silently rendering it would hide
 * that the writer stopped honouring it.
 */
function decimalText(payload: Record<string, unknown> | null, key: string): string | null {
    const v = payload?.[key];
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

export function composeCardText(
    card: CardView,
    copy: CardCopy,
): { senderLabel: string; body: string } | null {
    if (card.kind === 'NEWS') {
        const title = text(card.payload, 'title');
        // NO TITLE, NO CARD. A heading with an empty body renders as a label
        // floating over nothing, which reads as a broken post rather than as
        // an absent one — and the caller's fallback is the server's `body`,
        // which carries the headline anyway.
        if (!title) return null;
        const source = text(card.payload, 'source');
        return {
            senderLabel: copy.newsHeading,
            body: source ? `${title}\n\n${copy.newsSource({ source })}` : title,
        };
    }
    if (card.kind === 'LISTING') {
        const commodity = text(card.payload, 'commodity');
        const quantity = decimalText(card.payload, 'quantityTonnes');
        // NO COMMODITY OR NO QUANTITY, NO CARD — the NEWS arm's rule. A
        // listing line with a blank where the crop goes reads as a broken
        // post, and the caller falls back to the server's `body`, which
        // carries the seller's own description when there is one.
        if (!commodity || !quantity) return null;
        const price = decimalText(card.payload, 'pricePerTonne');
        const currency = text(card.payload, 'priceCurrency');
        const name = copy.commodityName(commodity);
        return {
            senderLabel: copy.listingHeading,
            // A price is OPTIONAL on a listing, so there are two sentences
            // rather than one with an empty slot: `translateFor` and
            // `next-intl`'s interpolator are both plain, so an absent value
            // would render as a dangling separator or a literal placeholder.
            body: price && currency
                ? copy.listingLineWithPrice({
                    commodity: name, quantity, price: `${price} ${currency}`,
                })
                : copy.listingLine({ commodity: name, quantity }),
        };
    }

    if (card.kind === 'SCHEME') {
        const title = text(card.payload, 'title');
        if (!title) return null;
        const closesOn = text(card.payload, 'closesOn');
        return {
            senderLabel: copy.schemeHeading,
            // The deadline is what a farmer acts on, so it follows the title
            // rather than replacing it. A scheme with no stated deadline is
            // the common case for an announcement and shows the title alone —
            // never an empty «Краен срок:».
            body: closesOn
                ? `${title}\n\n${copy.schemeDeadline({ date: copy.dayLabel(closesOn) })}`
                : title,
        };
    }

    if (card.kind === 'EVENT') {
        const title = text(card.payload, 'title');
        if (!title) return null;
        const startsAt = text(card.payload, 'startsAt');
        return {
            senderLabel: copy.eventHeading,
            body: startsAt
                ? `${title}\n\n${copy.eventWhen({ date: copy.dayLabel(startsAt) })}`
                : title,
        };
    }

    return null;
}
