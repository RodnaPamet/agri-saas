/**
 * Catch Russian leaking into Bulgarian model output.
 *
 * Reported by the owner 2026-11-01 from «Сателитно обобщение» on the dashboard:
 * «Преоцени поливния график и **проверь** влажността на почвата». «проверь» is
 * the Russian imperative; Bulgarian is «провери». Their words were "why does it
 * say проверь - this is not Bulgarian".
 *
 * The cause is the obvious one: a model told to write "Bulgarian (Cyrillic
 * script)" has far more Russian than Bulgarian in its training data, so under
 * pressure it drifts toward the bigger neighbour. The prompt now says so
 * explicitly, and this is the deterministic backstop for when it does it anyway.
 *
 * ## The rule, and why it is safe
 *
 * Bulgarian orthography has no **ы**, **э** or **ё** at all, and uses **ь**
 * only in the digraph **ьо** (шофьор, актьор, бельо). Russian uses all four
 * freely. So `[ыэё]` or a `ь` not followed by `о` is Russian, with no
 * Bulgarian word able to produce it.
 *
 * Measured against this product's own catalogue before being relied on:
 * **0 hits across all 6,113 Bulgarian strings (193,526 characters)**, while
 * firing on «проверь» and «ещё» and staying silent on «провери», «шофьор»,
 * «актьор» and «бельо». Both directions, because a detector that cannot fire
 * and one that fires on everything look identical from a green test.
 *
 * ## What it does NOT catch, stated so nobody assumes otherwise
 *
 * This is an ORTHOGRAPHIC check, not a grammatical one. The same report also
 * carried «указва водна стрес» (should be «воден стрес» — «стрес» is
 * masculine) and «средната влажност на пологовете» (not the Bulgarian word for
 * crop cover). Both are written in perfectly legal Bulgarian letters and this
 * function is blind to them. Those are the prompt's job, and nothing here
 * should be read as covering them.
 */

/**
 * The orthographic tell. Exported so a guard can prove it both fires and
 * refrains, rather than asserting about it.
 */
export const RUSSIAN_ORTHOGRAPHY = /[ыэё]|ь(?!о)/i;

/** Does this single string carry Russian orthography? */
export function hasRussianOrthography(s: string): boolean {
    return RUSSIAN_ORTHOGRAPHY.test(s);
}

/**
 * Every string inside `value` that carries Russian orthography, as `path :: text`.
 *
 * Walks arrays and plain objects. Deliberately NOT a generic deep walker over
 * exotic types — model output parsed by zod is plain JSON, so strings, arrays
 * and objects are the whole domain, and inventing Map/Set/Date handling here
 * would be untested code pretending to cover a case that cannot arrive.
 */
export function findRussianLeakage(value: unknown, path = ''): string[] {
    if (typeof value === 'string') {
        return hasRussianOrthography(value) ? [`${path || '<root>'} :: ${value}`] : [];
    }
    if (Array.isArray(value)) {
        return value.flatMap((v, i) => findRussianLeakage(v, `${path}[${i}]`));
    }
    if (value && typeof value === 'object') {
        return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
            findRussianLeakage(v, path ? `${path}.${k}` : k),
        );
    }
    return [];
}
