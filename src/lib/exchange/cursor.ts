/**
 * Opaque keyset cursors for the messaging reads.
 *
 * ## Why keyset and not offset
 *
 * An offset re-counts rows on every page and, worse, SHIFTS: a message arriving
 * between page 1 and page 2 pushes a row across the boundary, so the reader
 * sees one twice and never sees another. A conversation is the worst possible
 * place for that, because the thing being duplicated or dropped is something a
 * person said.
 *
 * ## Why the id is in the cursor
 *
 * Ordering on a timestamp ALONE is not a total order. Two threads whose
 * `lastMessageAt` is identical — same message batch, a seed, a clock with
 * millisecond resolution — compare equal, so `WHERE lastMessageAt < :ts`
 * either skips both or returns both again depending on which side of the
 * boundary they land. The id tiebreak makes the order total, and the cursor
 * therefore names exactly one row rather than a position among equals.
 *
 * The encoding is base64url and deliberately opaque: it is a position, not a
 * timestamp a client should read, parse, or construct. A client that builds its
 * own cursor has coupled itself to the sort key, and changing the sort key then
 * breaks it silently.
 */

export interface Cursor {
    at: Date;
    id: string;
}

/** Encode a position. Returns null for a null input so callers can pass through. */
export function encodeCursor(row: { at: Date; id: string } | null): string | null {
    if (!row) return null;
    return Buffer.from(`${row.at.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

/**
 * Decode a cursor, or return null if it is unusable.
 *
 * Returns null rather than throwing on a malformed value: a stale or truncated
 * cursor should restart the listing, not 500. A cursor that decodes to a
 * nonsense DATE is the case worth naming — `new Date('x')` is `Invalid Date`,
 * which compares false against everything, so a Prisma filter built on it
 * returns ZERO rows and reads to the caller as "no more pages" rather than as
 * an error.
 */
export function decodeCursor(raw: string | null | undefined): Cursor | null {
    if (!raw) return null;
    let decoded: string;
    try {
        decoded = Buffer.from(raw, 'base64url').toString('utf8');
    } catch {
        return null;
    }
    const sep = decoded.indexOf('|');
    if (sep <= 0) return null;
    const at = new Date(decoded.slice(0, sep));
    const id = decoded.slice(sep + 1);
    if (!id || Number.isNaN(at.getTime())) return null;
    return { at, id };
}

/**
 * The keyset predicate for a DESCENDING `(at, id)` order.
 *
 * Strictly "older than the cursor row": either the timestamp is behind, or it
 * ties and the id is behind. Written as a disjunction rather than a compound
 * comparison because Prisma has no row-value syntax, and getting this wrong in
 * the obvious way — `at: { lt }` alone — is what drops the tied rows.
 */
/**
 * The field names are enumerated rather than typed `string` so a typo cannot
 * silently build a predicate on a column the ORDER BY does not use — which
 * returns wrong rows rather than failing.
 */
export type KeysetDateField = 'lastMessageAt' | 'createdAt' | 'completedAt' | 'observedAt';

export function keysetBefore(cursor: Cursor, field: KeysetDateField) {
    return {
        OR: [
            { [field]: { lt: cursor.at } },
            { [field]: cursor.at, id: { lt: cursor.id } },
        ],
    };
}


// ─── Numeric first key ────────────────────────────────────────────────
//
// `ParcelCropSeason` is ordered by `year` DESC, an integer, not a timestamp.
// The date functions above cannot express that, and bending them by pretending
// a year is a date would put a fake January the 1st in the cursor and paginate
// on a value the ORDER BY does not use — which silently skips rows rather than
// failing.

export interface NumericCursor {
    n: number;
    id: string;
}

export function encodeNumericCursor(row: { n: number; id: string } | null): string | null {
    if (!row) return null;
    return Buffer.from(`${row.n}|${row.id}`, 'utf8').toString('base64url');
}

/** Same forgiving contract as `decodeCursor`: unusable in, null out. */
export function decodeNumericCursor(raw: string | null | undefined): NumericCursor | null {
    if (!raw) return null;
    let decoded: string;
    try {
        decoded = Buffer.from(raw, 'base64url').toString('utf8');
    } catch {
        return null;
    }
    const sep = decoded.indexOf('|');
    if (sep <= 0) return null;
    const n = Number(decoded.slice(0, sep));
    const id = decoded.slice(sep + 1);
    // `Number('')` is 0 and `Number('x')` is NaN — both would build a filter
    // that matches nothing and read as "no more pages".
    if (!id || !Number.isFinite(n)) return null;
    return { n, id };
}

/** Keyset predicate for a DESCENDING `(numericField, id)` order. */
export function keysetBeforeNumeric(cursor: NumericCursor, field: 'year') {
    return {
        OR: [
            { [field]: { lt: cursor.n } },
            { [field]: cursor.n, id: { lt: cursor.id } },
        ],
    };
}
