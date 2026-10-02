/**
 * `If-Match` as a version precondition: ONE parser, for every route with a lock.
 *
 * ## Why this is shared rather than per-route
 *
 * Three routes implement an optimistic lock and, before #1182, had three
 * different answers to the same header. Measured on the real parsers:
 *
 * ```
 * header      journal /^\d+$/        field-operations parseInt+isInteger
 * 5           5                      5
 * "5"         undefined UNGUARDED    undefined UNGUARDED
 * W/"5"       undefined UNGUARDED    undefined UNGUARDED
 * 0abc        undefined UNGUARDED    0            <- coerced
 * -1          undefined UNGUARDED    -1           <- accepted
 * ```
 *
 * Two distinct defects live in that table.
 *
 * **A quoted tag was silently unguarded on both.** `"5"` is the RFC 7232 wire
 * format, so the clients most likely to send it are the well-behaved ones — a
 * client asks for protection, is given none, and is told nothing. On the
 * journal route that is the offline outbox replay path, where losing the
 * precondition lets a queued edit clobber a supervisor's later change, which is
 * the exact loss #919/#921 built the lock to prevent.
 *
 * **And the looser parser COERCES.** `0abc` and `0x0` became `0`, and `-1` was
 * accepted. Harmless on `field-operations`, where 0 is not a sentinel — and not
 * harmless the moment that parser is copied into a design where it is. That is
 * live: `farm-profile` uses `version 0` to mean "no row exists yet", so a
 * malformed header coerced to 0 would become a CREATE attempt. `farm-profile`
 * wrote its own strict parser rather than reuse it, and this module is that
 * parser extracted — the convergence #1182 asked for, so a fourth route cannot
 * pick the looser one.
 *
 * ## The rule
 *
 *   absent                 -> undefined. No precondition, last-write-wins.
 *                             Documented behaviour, and the common case for an
 *                             online edit from a modal.
 *   `5`                    -> 5. The house convention; both clients' outboxes
 *                             send this form.
 *   `"5"`                  -> 5. A strong entity-tag, the RFC 7232 format.
 *   `W/"5"`                -> 400. RFC 7232 forbids weak comparison for
 *                             If-Match, and weak is meaningless for a version.
 *   anything else          -> 400.
 *
 * ## Why these carry CODES
 *
 * `codedBadRequest`, not `badRequest`. Extracting the parser out of a route
 * under `src/app` and into `src/lib` moved its messages INTO the scope of
 * `no-server-authored-user-copy` (`ROOTS = ['src/app-layer', 'src/lib']`), and
 * that ratchet went red — correctly. Its own docblock states the remedy: a
 * throw carrying a machine-readable code is exempt, because *"a code is what a
 * client can translate; the English beside it becomes the fallback for a code
 * the client does not recognise."*
 *
 * So the convergence improved the error contract as a side effect rather than
 * paying a ratchet to allow it. `IF_MATCH_WEAK_TAG` is something the iOS app
 * can render in Bulgarian; the sentence after it is what a client that has
 * never seen the code falls back to.
 *
 * **Present-but-unparseable is an ERROR, never a fall-through.** That asymmetry
 * is the whole point: absent means the caller wants no precondition, while
 * present means they want one, and guessing on their behalf is how a lost
 * update happens quietly. A 400 costs a well-behaved client one fixed header;
 * a silent fall-through costs somebody their edit.
 */
import { codedBadRequest } from '@/lib/errors/types';

/**
 * Parse an `If-Match` header into an expected version.
 *
 * Returns `undefined` only when the header is ABSENT. Throws `badRequest` for
 * any present value it cannot read as a version.
 */
export function parseIfMatch(raw: string | null | undefined): number | undefined {
    if (raw === null || raw === undefined) return undefined;

    const value = raw.trim();
    // An empty or whitespace-only header is PRESENT. Treating it as absent is
    // the fall-through this module exists to remove — a client that sent the
    // header meant to send a version.
    if (value.length === 0) {
        throw codedBadRequest(
            'IF_MATCH_EMPTY',
            'If-Match was sent empty. Omit the header for no precondition, or send the version.',
            { header: 'If-Match' },
        );
    }

    if (/^W\//i.test(value)) {
        throw codedBadRequest(
            'IF_MATCH_WEAK_TAG',
            'A weak entity-tag cannot be used with If-Match. Send the version as a bare integer or a strong tag.',
            { header: 'If-Match' },
        );
    }

    // A strong entity-tag is the same number in quotes.
    const unquoted = /^"(.*)"$/.exec(value)?.[1] ?? value;
    if (!/^\d+$/.test(unquoted)) {
        throw codedBadRequest(
            'IF_MATCH_MALFORMED',
            'If-Match must be the row version as a bare integer (5) or a strong entity-tag ("5").',
            { header: 'If-Match' },
        );
    }

    return Number.parseInt(unquoted, 10);
}

/**
 * The strong entity-tag for a version, so a client may echo it back verbatim.
 *
 * Emitting what `parseIfMatch` accepts is what makes the round trip work
 * without the client reformatting anything.
 */
export const etagFor = (version: number): string => `"${version}"`;
