/**
 * A reader's own Новини tag opt-ins — read, validate, write.
 *
 * `User.newsTagPreferences` is a `Json?` column, so everything that comes back
 * from it is `unknown` and has to be narrowed here. This module is the only
 * place that touches it, which is what keeps the two asymmetric rules from
 * drifting apart:
 *
 *   · **ignore unknown on READ.** Tags get renamed and removed. A stored
 *     preference validated only when it was written would otherwise filter a
 *     feed down to nothing, with no way for the reader to understand why.
 *   · **reject unknown on WRITE.** The server owns this vocabulary by the
 *     owner's decision, so an unknown key on `PUT` is a client bug worth a
 *     400 rather than something to store and silently drop.
 *
 * Those are not in tension once you ask who chose the value. A read is a
 * pass-through of state the server itself issued; a write is a person
 * choosing.
 *
 * ## `null` and `[]` are different answers
 *
 * `null` means "never chose", `[]` means "chose nothing". Both show the full
 * feed, so the distinction does not affect filtering at all — it decides
 * whether the UI may prompt. Collapsing them would make a brand-new reader
 * indistinguishable from one who deliberately cleared their choices, and
 * those two want opposite treatment. Every function here preserves it.
 */
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import prisma from '@/lib/prisma';
import { ALL_NEWS_TAGS } from './categorize';

/**
 * Upper bound on a stored preference list.
 *
 * The vocabulary is a closed set, so the real bound is its size — this exists
 * so a malformed or hostile body cannot store an arbitrarily long array in a
 * `Json` column that every feed read then has to parse. Deliberately larger
 * than the current vocabulary so adding tags does not need a migration of
 * this constant.
 */
export const MAX_NEWS_TAG_PREFERENCES = 64;

/**
 * The PUT body. Rejects an unknown tag by name rather than silently dropping
 * it, and de-duplicates — asking for `['wheat','wheat']` is one choice, and
 * storing it twice would make the list's length meaningless.
 *
 * Not sorted on write: the stored order is the reader's, and nothing depends
 * on it. The FEED sorts, because there a cache key depends on it.
 */
export const NewsPreferencesBodySchema = z.object({
    tags: z
        .array(z.string().min(1).max(64))
        .max(MAX_NEWS_TAG_PREFERENCES)
        .transform((raw) => [...new Set(raw)])
        .superRefine((tags, ctx) => {
            const known = new Set(ALL_NEWS_TAGS);
            const unknown = tags.filter((t) => !known.has(t));
            if (unknown.length > 0) {
                ctx.addIssue({
                    code: 'custom',
                    // Names them, so a client bug is diagnosable from the
                    // response rather than by diffing against the catalogue.
                    message: `unknown tag(s): ${unknown.join(', ')} — see GET /api/t/{tenantSlug}/trends/news/tags`,
                });
            }
        }),
});

export type NewsPreferencesBody = z.infer<typeof NewsPreferencesBodySchema>;

/**
 * Narrow a stored `Json?` value to a tag list, dropping anything unknown.
 *
 * Returns `null` ONLY for a genuinely absent preference. A stored value that
 * is the wrong SHAPE — an object, a string, a number, an array of numbers —
 * also reads as `null`, and that is the honest answer: a malformed value is
 * not a choice anybody made, and treating it as `[]` would claim the reader
 * chose nothing.
 */
export function readNewsPreferences(stored: unknown): string[] | null {
    if (!Array.isArray(stored)) return null;
    const known = new Set(ALL_NEWS_TAGS);
    return stored.filter((t): t is string => typeof t === 'string' && known.has(t));
}

/**
 * The caller's own stored preference, unknown tags dropped.
 *
 * `null` for a reader who has never chosen — see the module note; the
 * distinction from `[]` is the whole reason this returns a nullable.
 */
export async function readOwnNewsPreferences(userId: string): Promise<string[] | null> {
    const row = await prisma.user.findUnique({
        where: { id: userId },
        select: { newsTagPreferences: true },
    });
    // A user that does not exist and a user who never chose are the same
    // answer HERE: both mean "no preference to apply". The route cannot reach
    // the first case anyway — the id comes from a verified session.
    return readNewsPreferences(row?.newsTagPreferences ?? null);
}

/**
 * Replace the caller's own preference.
 *
 * `Prisma.DbNull` rather than `null` for the cleared case, mirroring
 * `updateOwnBottomTabOrder`: plain `null` on a `Json?` column is Prisma's
 * JsonNull, which stores the JSON value `null` INSIDE the column rather than
 * making the column NULL. The two read back differently — `readNewsPreferences`
 * would see a non-array and answer `null` either way today, but storing a JSON
 * null would make "never chose" and "explicitly stored nothing" two different
 * database states claiming to be one, which is the distinction this file exists
 * to keep straight.
 *
 * Takes the validated list, so an unknown tag has already been refused. Writes
 * `[]` as a real empty array — "chose nothing" is a choice and must survive the
 * round trip.
 */
export async function writeOwnNewsPreferences(
    userId: string,
    tags: string[] | null,
): Promise<string[] | null> {
    const updated = await prisma.user.update({
        where: { id: userId },
        data: { newsTagPreferences: tags === null ? Prisma.DbNull : tags },
        select: { newsTagPreferences: true },
    });
    return readNewsPreferences(updated.newsTagPreferences);
}
