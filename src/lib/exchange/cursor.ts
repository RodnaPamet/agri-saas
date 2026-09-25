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
export function keysetBefore(cursor: Cursor, field: 'lastMessageAt' | 'createdAt') {
    return {
        OR: [
            { [field]: { lt: cursor.at } },
            { [field]: cursor.at, id: { lt: cursor.id } },
        ],
    };
}
