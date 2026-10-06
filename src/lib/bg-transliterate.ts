/**
 * Bulgarian Cyrillic → Latin, for slugs and handles (P3.3).
 *
 * Implements the **Streamlined System**, which is not a stylistic choice: it is
 * the transliteration prescribed by the Закон за транслитерацията (2009) and
 * the one on Bulgarian passports and road signs. A farmer who types «Победа»
 * expects `pobeda`, because that is what every official document they own says.
 *
 * ── the one rule people get wrong ──
 *
 * `ъ → a`, not `u` or `y`. «Търговище» is `Targovishte` on the road sign. The
 * instinct to write `Turgovishte` comes from older ad-hoc schemes and is what
 * makes a hand-rolled table disagree with the passport in the user's pocket.
 *
 * ── and the exception the law actually spells out ──
 *
 * A word ending in `-ия` transliterates to `-ia`, not `-iya`: «София» is
 * `Sofia`. Applied at word boundaries only, so «Иван» stays `Ivan` and a
 * mid-word `ия` is untouched.
 *
 * ── why this is a cross-client contract, not a utility ──
 *
 * The output becomes a tenant **slug** and a public **handle** — they appear in
 * URLs and are stored. If iOS transliterates differently, the same farm name
 * yields two different handles and whichever client registers second gets a
 * collision or a stranger's farm. Same class of agreement as the identifier
 * checksums in `bg-identifiers.ts`, and the same warning applies: implement
 * from the standard and compare, rather than copying these tables.
 *
 * Latin input passes through unchanged, so a farm already named "AgroTech" is
 * not mangled on its way to a slug.
 */

/**
 * The Streamlined System table.
 *
 * Multi-character outputs (`zh`, `sht`, `ya`) are why this is a map rather than
 * an index-for-index substitution — the output is longer than the input and
 * length-based slicing elsewhere would be wrong.
 */
const LETTERS: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z',
    и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
    р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch',
    ш: 'sh', щ: 'sht', ъ: 'a', ь: 'y', ю: 'yu', я: 'ya',
};

/** `-ия` at the end of a word → `-ia`. София → Sofia, not Sofiya. */
const IA_WORD_END = /ия(?=$|[^а-яa-z0-9])/giu;

/**
 * Transliterate Bulgarian Cyrillic to Latin.
 *
 * Case is preserved for the first character of a multi-letter mapping only —
 * «Жельо» becomes `Zhelyo`, not `ZHelyo` — which is what the official system
 * does and what looks right in a name.
 */
export function transliterate(input: string): string {
    // The `-ия` rule runs first: once `я` has become `ya` the word ending is
    // gone and the exception can no longer be seen.
    const pre = input.replace(IA_WORD_END, (m) => (m[0] === m[0].toUpperCase() ? 'Ia' : 'ia'));

    let out = '';
    for (const ch of pre) {
        const lower = ch.toLowerCase();
        const mapped = LETTERS[lower];
        if (mapped === undefined) {
            out += ch;
            continue;
        }
        out += ch === lower ? mapped : mapped[0].toUpperCase() + mapped.slice(1);
    }
    return out;
}

/** Longest slug we will emit. Matches the `admin/tenants` route's `max(80)`. */
export const MAX_SLUG_LENGTH = 80;

/**
 * A URL-safe slug from any farm name, Cyrillic or Latin.
 *
 * Returns `null` when nothing usable survives — an all-punctuation or
 * all-emoji name. `null` rather than a generated fallback on purpose: the
 * caller has to decide what to do, and a silent `farm-1` would put a name in a
 * URL that the owner never chose and cannot recognise.
 */
export function toSlug(name: string): string | null {
    const slug = transliterate(name)
        .toLowerCase()
        // Strip diacritics that survive from Latin input (é → e) so a slug is
        // always plain ASCII.
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, MAX_SLUG_LENGTH)
        // A trailing hyphen can reappear after the slice.
        .replace(/-+$/g, '');
    return slug.length > 0 ? slug : null;
}
