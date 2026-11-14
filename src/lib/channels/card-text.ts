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

/** The catalogue strings this composer needs, already resolved for a locale. */
export interface CardCopy {
    newsHeading: string;
    newsSource: (vars: { source: string }) => string;
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
    return null;
}
