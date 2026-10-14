/**
 * What makes a public handle valid — P6.6 (#1815).
 *
 * `FarmBrand.handle` is the only key `/f/[handle]` has, and the namespace is
 * global across every tenant. Three rules decide whether a farm may take one,
 * and they live here together so a refusal has ONE shape whichever rule fired:
 * shape, reserved words, and availability. Availability is the one rule this
 * module cannot answer — see below.
 *
 * ## Normalise at the point of choice, not at read time
 *
 * `FarmBrand.handle`'s `@unique` is a plain Postgres unique index, so it is
 * CASE-SENSITIVE: `Pobeda` and `pobeda` are two reservations that collapse to
 * one projection row, and the reader lower-cases, so the second farm to
 * publish would silently take over the first one's page. Normalising here —
 * once, when the owner chooses — is what prevents that, and it is why
 * `checkHandleShape` returns the handle to store rather than a boolean.
 *
 * ## What is actually reserved, and what is not
 *
 * A handle is always the SECOND path segment (`/f/<handle>`), so it cannot
 * collide with a top-level route: `/f/api` is not `/api`, and `/f/login` is
 * not `/login`. An earlier note on #1815 listed `api`, `t`, `org`, `_next`
 * and `.well-known` as reserved; none of them can collide and none of them is
 * reserved here. What can collide is a future STATIC SIBLING of `[handle]`
 * under `src/app/f/` — Next resolves a static segment before a dynamic one,
 * so adding `/f/directory` would shadow a farm already holding that handle,
 * its page would stop answering, and nothing would report it. There are no
 * such siblings today; a guard derives them from the route tree and fails if
 * one appears unreserved, because a hand-kept list goes stale exactly when it
 * matters.
 *
 * The rest of the list is platform impersonation, which is a trust judgement
 * rather than a routing fact: a farm at `/f/support` reads as the platform to
 * a stranger arriving from a shared link. It is deliberately SHORT — a long
 * denylist guesses at abuse nobody has attempted, and the cost of guessing
 * wrong is refusing a real farm its own name.
 *
 * ## Availability is not in here
 *
 * Checking it needs a database read, and the answer is advisory the moment it
 * returns: two owners can submit the same handle in the same second. The
 * unique index is the only thing that actually prevents a collision, so the
 * flow is suggest-then-attempt and a `23505` on insert is a NORMAL outcome to
 * handle, not an error to log. This module supplies the two pure halves of
 * that flow — the shape rules, and the suggestions to offer when the name is
 * gone — and the usecase composes them with the write.
 */
import { MAX_SLUG_LENGTH, toSlug } from '@/lib/bg-transliterate';

/**
 * Three characters, so a handle is still a name rather than an initial. The
 * floor is on the NORMALISED slug, which matters for Cyrillic: `ЗП` is two
 * characters that transliterate to `zp`, and both are refused.
 */
export const HANDLE_MIN_LENGTH = 3;

/**
 * Forty, which is half of `MAX_SLUG_LENGTH`. A handle is typed, read aloud,
 * and printed on the A6 card P6.7 ships; eighty characters is a slug budget,
 * not an address a person uses.
 */
export const HANDLE_MAX_LENGTH = 40;

/** At most three, because a refusal offering more reads as a list to audit. */
export const MAX_HANDLE_SUGGESTIONS = 3;

/**
 * Platform impersonation only. Route siblings are NOT listed here because
 * there are none; the guard that derives them will fail if that changes.
 */
export const RESERVED_HANDLES: readonly string[] = [
    'admin',
    'administrator',
    'moderator',
    'support',
    'help',
    'security',
    'official',
    'agrent',
    'agrent-bg',
];

export type HandleRefusalCode =
    | 'FARM_HANDLE_UNUSABLE'
    | 'FARM_HANDLE_TOO_SHORT'
    | 'FARM_HANDLE_TOO_LONG'
    | 'FARM_HANDLE_RESERVED';

export type HandleShapeVerdict =
    | {
          readonly ok: true;
          /** The handle to STORE — already normalised, never the raw input. */
          readonly handle: string;
          /**
           * True when the stored handle differs from what the owner typed, so
           * the editor can show the address it will actually serve instead of
           * letting them discover it after publishing.
           */
          readonly normalised: boolean;
      }
    | { readonly ok: false; readonly code: HandleRefusalCode };

/** Exact match on the normalised slug — these are addresses, not substrings. */
export function isReservedHandle(handle: string): boolean {
    return RESERVED_HANDLES.includes(handle);
}

export function checkHandleShape(raw: string): HandleShapeVerdict {
    const typed = raw.trim();

    // The DEFAULT `MAX_SLUG_LENGTH`, deliberately not `HANDLE_MAX_LENGTH`.
    // Passing the shorter cap would make `toSlug` TRUNCATE an over-long name
    // and return a valid-looking handle, so the owner would silently get a
    // cut-off address instead of being told the name is too long. Mechanical
    // normalisation is fair game; dropping half the name is not.
    const slug = toSlug(typed, MAX_SLUG_LENGTH);

    if (slug === null) return { ok: false, code: 'FARM_HANDLE_UNUSABLE' };
    if (slug.length < HANDLE_MIN_LENGTH) return { ok: false, code: 'FARM_HANDLE_TOO_SHORT' };
    if (slug.length > HANDLE_MAX_LENGTH) return { ok: false, code: 'FARM_HANDLE_TOO_LONG' };
    if (isReservedHandle(slug)) return { ok: false, code: 'FARM_HANDLE_RESERVED' };

    return { ok: true, handle: slug, normalised: slug !== typed };
}

/**
 * Derived alternatives for a handle that is taken or refused.
 *
 * Every candidate comes from something the farm already declared — its oblast
 * and its public name — because `pobeda-dobrich` tells a farmer something and
 * `pobeda-2` tells them only that they were second. That is the ruling on
 * #1815, and it has a consequence worth stating: when nothing is derivable
 * this returns an EMPTY array, and the caller must refuse plainly rather than
 * fall back to a counter.
 *
 * `taken` is whatever the caller has already looked up. It is advisory — see
 * the module header — so a suggestion coming back here is not a promise that
 * the insert will succeed.
 */
export function suggestHandles(
    raw: string,
    context: { readonly oblast?: string | null; readonly displayName?: string | null },
    taken: ReadonlySet<string> = new Set(),
): string[] {
    const base = toSlug(raw.trim(), MAX_SLUG_LENGTH);
    const oblast = context.oblast ? toSlug(context.oblast, MAX_SLUG_LENGTH) : null;
    const name = context.displayName ? toSlug(context.displayName, MAX_SLUG_LENGTH) : null;

    const candidates: Array<string | null> = [
        base && oblast ? `${base}-${oblast}` : null,
        name,
        name && oblast ? `${name}-${oblast}` : null,
        oblast && base ? `${oblast}-${base}` : null,
    ];

    const out: string[] = [];
    for (const candidate of candidates) {
        if (candidate === null) continue;
        const verdict = checkHandleShape(candidate);
        // A suggestion has to pass the same rules it is offered against —
        // otherwise the editor proposes an address the write would refuse.
        if (!verdict.ok) continue;
        if (verdict.handle === base) continue; // offering back what they asked for is noise
        if (taken.has(verdict.handle)) continue;
        if (out.includes(verdict.handle)) continue;
        out.push(verdict.handle);
        if (out.length === MAX_HANDLE_SUGGESTIONS) break;
    }
    return out;
}
