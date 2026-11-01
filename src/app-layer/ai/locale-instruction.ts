import { type Locale } from '@/lib/i18n/locales';

/**
 * A system-prompt line that pins the model's OUTPUT LANGUAGE to the user's UI
 * locale. Every AI surface that emits user-facing prose (field briefings,
 * agronomy explanations, photo recommendations, the safety advisor, risk
 * suggestions) appends this to its system prompt so a Bulgarian user reads
 * Bulgarian, not English.
 *
 * Returns '' for English (the models already default to English, so there's
 * nothing to add and no tokens to spend). Product names, units, chemical
 * names and codes are explicitly kept verbatim so we don't get "ха" for "ha"
 * or a transliterated brand.
 *
 * Locale is resolved from `getLocale()` (next-intl) in request scope, or from
 * the owning user's persisted `User.uiLanguage` in background jobs — narrow
 * untrusted values with `isLocale()` before calling.
 */
export function localeOutputInstruction(locale: Locale | string | null | undefined): string {
    if (locale === 'bg') {
        return (
            'Write your ENTIRE response in standard modern Bulgarian. ' +
            'All natural-language prose — summaries, explanations, recommendations, ' +
            'headlines and any free-text field values — must be written in Bulgarian. ' +
            // Naming the WRONG language is the load-bearing part. The previous
            // wording said "Bulgarian (Cyrillic script)", and a model holding far
            // more Russian than Bulgarian drifted to the bigger neighbour while
            // still satisfying "Cyrillic": the owner was shown «проверь» (Russian
            // imperative) where Bulgarian is «провери», 2026-11-01. Saying
            // "Cyrillic" invited precisely the failure it was meant to prevent.
            'Bulgarian is NOT Russian: never use Russian words, Russian verb forms or ' +
            'Russian spelling. The letters ы, э and ё do not exist in Bulgarian, and ь ' +
            'appears only in the combination ьо (шофьор, актьор). Bulgarian imperatives ' +
            'end in -и or -ай (провери, изчакай), never in -ь (проверь is Russian). ' +
            // The same report carried two errors no orthographic check can see,
            // so they are addressed where they can be: in the instruction.
            'Make adjectives agree with the gender of their noun (воден стрес, not водна стрес). ' +
            'Use the ordinary Bulgarian agronomic word for a thing, not a Russian cognate. ' +
            'Keep product names, brand names, chemical/active-ingredient names, units ' +
            '(e.g. ha, kg, l, t/ha, mm, °C), codes and identifiers exactly as given; do not transliterate them.'
        );
    }
    return '';
}

/**
 * Append the language instruction to an existing system prompt. Convenience
 * for the common "system string + one extra line" shape. Returns `system`
 * unchanged for English (or an empty instruction).
 */
export function withLocaleInstruction(system: string, locale: Locale | string | null | undefined): string {
    const line = localeOutputInstruction(locale);
    return line ? `${system}\n\n${line}` : system;
}
