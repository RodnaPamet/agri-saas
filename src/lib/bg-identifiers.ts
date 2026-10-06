/**
 * Bulgarian business and personal identifiers (P3.2).
 *
 * Three things live here, and the third is the one that needs care.
 *
 * ── ЕИК (БУЛСТАТ) — validate ──
 *
 * The company identifier, 9 digits for a legal entity and 13 for a branch or
 * sub-unit. Both carry a checksum, so a typo is detectable client-side without
 * asking any registry. That is the whole point: registration can tell "that is
 * not an ЕИК" apart from "that ЕИК is not in the register", which are different
 * answers and deserve different copy.
 *
 * ── ЕГН — detect, in order to REFUSE ──
 *
 * The personal identifier. Ten digits, its own checksum, and it encodes a
 * birth date — so it is sensitive personal data under GDPR Art 9-adjacent
 * reasoning and under Bulgarian practice.
 *
 * **This module detects an ЕГН so a caller can refuse it, never so a caller can
 * store it.** The case that matters: a sole trader types their ЕГН into the
 * ЕИК field at registration. Without a detector that is either accepted as
 * garbage or rejected with a useless "invalid ЕИК"; with one we can say
 * precisely what is wrong and decline to keep the value.
 *
 * **This is NOT a ban on ЕГН in the product.** `FarmProfile.egn` legitimately
 * stores one, encrypted under the Epic B manifest, because the БАБХ ДНЕВНИК
 * (Прил. 1 към заповед РД 11-3194/31.12.2021) has a field for it and a sole
 * trader's form is invalid without it. The refusal is scoped to the identifier
 * being asked for, not to the number existing.
 *
 * Consequently `looksLikeEgn` must never log or echo its input, and callers
 * must not put the value in an error message, a URL or a metric label. A
 * boolean is the entire output on purpose.
 *
 * ── on the test vectors, and a warning for the iOS side ──
 *
 * The vectors in `tests/unit/bg-identifiers.test.ts` are DERIVED from these
 * algorithms, not taken from a registry. They therefore prove internal
 * consistency and the digit-uniqueness property — for any prefix exactly one
 * check digit is valid — but they do NOT prove conformance to the published
 * standard. If this implementation has the weights wrong, a second
 * implementation that copies the vectors is wrong in the same way and the two
 * agree perfectly.
 *
 * So: implement from the standard on your side, then compare. Agreement is
 * evidence only if the two were derived independently.
 */

/** Digits only, nothing else — no spaces, no prefix, no separators. */
const DIGITS_ONLY = /^\d+$/;

function digits(value: string): number[] | null {
    const v = value.trim();
    if (!DIGITS_ONLY.test(v)) return null;
    return [...v].map(Number);
}

/**
 * Weighted mod-11 with the standard's fallback.
 *
 * Every Bulgarian identifier checksum here is the same shape: multiply by a
 * weight vector, take mod 11, and if the result is 10 try a second vector; if
 * that is also 10 the check digit is 0. Writing it once keeps the three
 * call sites from drifting apart.
 */
function mod11(ds: number[], primary: number[], fallback?: number[]): number {
    const sum = (w: number[]) => ds.reduce((acc, d, i) => acc + d * w[i], 0);
    let r = sum(primary) % 11;
    if (r !== 10) return r;
    if (!fallback) return 0;
    r = sum(fallback) % 11;
    return r === 10 ? 0 : r;
}

/** The 9-digit base every ЕИК starts with. */
function isValidEik9(ds: number[]): boolean {
    const check = mod11(
        ds.slice(0, 8),
        [1, 2, 3, 4, 5, 6, 7, 8],
        [3, 4, 5, 6, 7, 8, 9, 10],
    );
    return check === ds[8];
}

/**
 * Is this a structurally valid ЕИК (БУЛСТАТ)?
 *
 * 9 digits for a legal entity, 13 for a branch — and a 13-digit code must carry
 * a valid 9-digit base, because the last four identify a sub-unit OF that
 * entity. A 13-digit value whose first nine are invalid is not "a branch of
 * something unknown"; it is a typo.
 *
 * Structural only. It says nothing about whether the entity exists, is active,
 * or is the caller's — `/api/public/eik-check` (P3.7) answers that, and this
 * runs first so the registry is never asked about a number that cannot exist.
 */
export function isValidEik(value: string): boolean {
    const ds = digits(value);
    if (!ds) return false;
    if (ds.length !== 9 && ds.length !== 13) return false;
    if (!isValidEik9(ds)) return false;
    if (ds.length === 9) return true;

    const check = mod11(ds.slice(8, 12), [2, 7, 3, 5], [4, 9, 5, 7]);
    return check === ds[12];
}

/**
 * Does this look like an ЕГН?
 *
 * Checksum AND a decodable birth date — both, because ten digits with a valid
 * mod-11 check but an impossible date (month 17, day 94) is more likely a
 * mistyped ЕИК than a personal number, and calling that an ЕГН would send the
 * user the wrong error.
 *
 * The month encodes the century: +40 for 2000s, +20 for 1800s, bare for 1900s.
 *
 * Returns a boolean and nothing else. See the module docblock — the input must
 * not be logged, echoed into an error, or put in a URL or metric label.
 */
export function looksLikeEgn(value: string): boolean {
    const ds = digits(value);
    if (!ds || ds.length !== 10) return false;

    if (mod11(ds.slice(0, 9), [2, 4, 8, 5, 10, 9, 7, 3, 6]) !== ds[9]) return false;

    let month = ds[2] * 10 + ds[3];
    if (month > 40) month -= 40;
    else if (month > 20) month -= 20;
    if (month < 1 || month > 12) return false;

    const day = ds[4] * 10 + ds[5];
    return day >= 1 && day <= 31;
}

/**
 * What a caller should say about a value typed into an ЕИК field.
 *
 * One function rather than three booleans at the call site, so every surface
 * gives the same answer to the same input and the ЕГН branch cannot be
 * forgotten — which is the branch that must not store or echo the value.
 */
export type EikVerdict = 'VALID' | 'LOOKS_LIKE_EGN' | 'INVALID';

export function classifyEikInput(value: string): EikVerdict {
    if (isValidEik(value)) return 'VALID';
    if (looksLikeEgn(value)) return 'LOOKS_LIKE_EGN';
    return 'INVALID';
}
