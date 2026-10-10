/**
 * The Новини feed's page cursor — KEYSET, not offset.
 *
 * The feed orders by `publishedAt desc`, and the pull inserts new articles at
 * the top several times a day. An offset cursor over a list that grows at the
 * head RE-SHOWS rows: insert three articles between page 1 and page 2, and
 * `skip: 50` starts three rows back up the list, so the reader sees three
 * duplicates and never learns why. Keyset pagination asks for "older than the
 * last row I have", which is stable under insertion at the head.
 *
 * ## Why the id is in the cursor
 *
 * `publishedAt` is not unique — four feeds publish on the hour, and the two
 * Bulgarian sources routinely share a timestamp to the second. A cursor
 * carrying only the timestamp must then choose between `lt` (which SKIPS every
 * other row sharing that second) and `lte` (which RE-SHOWS them). Neither is
 * acceptable on a regulated-looking list a farmer scrolls. The pair
 * `(publishedAt, id)` is unique, so the comparison is a true tuple comparison
 * and every row appears exactly once.
 *
 * ## Why it is opaque
 *
 * The contract says "opaque; pass back verbatim", and base64url is what makes
 * that honest: a client that can read `2026-10-09T06:00:00.000Z|clx…` will
 * eventually construct one, and then the cursor format is a public API that
 * cannot change. Base64 is not security — it is a sign that says "do not
 * parse me", which is all this needs.
 *
 * A malformed or stale cursor is IGNORED rather than refused. A reader whose
 * saved cursor points at an article the 60-day retention has since deleted
 * should get the first page, not a 400: the alternative is a feed that stays
 * broken until they clear their state, for a parameter the server issued.
 */

/** The keyset position a cursor names. */
export interface FeedCursor {
    publishedAt: Date;
    id: string;
}

const SEP = '|';

/** Encode a row's position. */
export function encodeFeedCursor(row: { publishedAt: Date; id: string }): string {
    return Buffer.from(`${row.publishedAt.toISOString()}${SEP}${row.id}`, 'utf8').toString(
        'base64url',
    );
}

/**
 * Decode a cursor, or `null` for anything that is not one.
 *
 * Every failure mode lands on `null` deliberately — bad base64, a missing
 * separator, an unparseable date, an empty id. See the module note: an ignored
 * cursor shows page one, a refused one shows an error for as long as the
 * client keeps sending it.
 */
export function decodeFeedCursor(raw: string | null | undefined): FeedCursor | null {
    if (!raw) return null;
    let decoded: string;
    try {
        decoded = Buffer.from(raw, 'base64url').toString('utf8');
    } catch {
        return null;
    }
    const sep = decoded.indexOf(SEP);
    if (sep <= 0 || sep === decoded.length - 1) return null;
    const publishedAt = new Date(decoded.slice(0, sep));
    const id = decoded.slice(sep + 1);
    if (Number.isNaN(publishedAt.getTime()) || id.length === 0) return null;
    return { publishedAt, id };
}

/**
 * The Prisma `where` fragment for "strictly older than this position".
 *
 * Spelled as the tuple comparison rather than `publishedAt: { lt }`, which
 * would skip the rest of the cursor row's second. Returns `undefined` for no
 * cursor so a caller can spread it unconditionally.
 */
export function cursorWhere(cursor: FeedCursor | null): Record<string, unknown> | undefined {
    if (!cursor) return undefined;
    return {
        OR: [
            { publishedAt: { lt: cursor.publishedAt } },
            { publishedAt: cursor.publishedAt, id: { lt: cursor.id } },
        ],
    };
}
