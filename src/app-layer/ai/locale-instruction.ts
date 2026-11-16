import { type Locale } from '@/lib/i18n/locales';

/**
 * A system-prompt line that pins the model's OUTPUT LANGUAGE to the user's UI
 * locale, so a Bulgarian user reads Bulgarian rather than English.
 *
 * ## Who actually applies it — measured, because this claim was wrong
 *
 * It read "Every AI surface that emits user-facing prose (field briefings,
 * agronomy explanations, photo recommendations, the safety advisor, risk
 * suggestions) appends this". Measured 2026-11-16, the importers are
 * `field-briefing.ts`, `news-event-extractor.ts`, `support-scheme-extractor.ts`
 * and `llm-client.ts` — and two of those three surfaces are EXTRACTORS whose
 * output is structured data rather than prose.
 *
 * The **assistant** was not among them, and it is the most conversational
 * surface in the product. A coverage sentence that enumerates surfaces and
 * scores the biggest consumer zero is worse than none, because it reads as
 * done. It uses `CONDITIONAL_BULGARIAN_PROSE_RULE` below, which is the same
 * rules phrased for a surface that answers in the question's language.
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
/**
 * How the product addresses a person: «Вие», never «ти» — #3090.
 *
 * Measured over `messages/bg/app.json` (6,572 strings): **134 carry a formal
 * second person** (`Вие` / `Ви` / `Вас` / `Ваш*`) and **ZERO carry an informal
 * one** (`ти` / `твой*` / `тебе`). So this is not a style preference against a
 * mixed codebase — it is a unanimous convention, and a model answering «ти»
 * contradicts every string around it.
 *
 * The owner was addressed as «ти» by the assistant on 2026-11-15, which is
 * what produced this constant. Shared rather than written into one prompt,
 * because the register is a property of the PRODUCT and not of one surface.
 */
export const BULGARIAN_REGISTER_RULE =
    'Address the reader with the FORMAL second person («Вие», «Ви», «Вашият») and '
    + 'never the informal «ти» or «твой» — including in imperatives, where the polite '
    + 'form is «проверете» rather than «провери».';

/**
 * The Bulgarian prose rules, in ONE place — two consumers phrase them
 * differently and must not hold two copies.
 *
 * Every clause is here because it reached a user. The "Bulgarian is NOT
 * Russian" wording replaced "Bulgarian (Cyrillic script)", which a model
 * holding far more Russian than Bulgarian satisfied while drifting to the
 * bigger neighbour: the owner was shown «проверь» (a Russian imperative) where
 * Bulgarian is «провери», 2026-11-01. Saying "Cyrillic" invited exactly the
 * failure it was meant to prevent. The same report carried two errors no
 * orthographic check can see — a mis-agreed adjective and a Russian cognate —
 * so they are addressed where they can be.
 */
const BULGARIAN_PROSE_RULES =
    'Bulgarian is NOT Russian: never use Russian words, Russian verb forms or '
    + 'Russian spelling. The letters ы, э and ё do not exist in Bulgarian, and ь '
    + 'appears only in the combination ьо (шофьор, актьор). Bulgarian imperatives '
    + 'end in -и or -ай (провери, изчакай), never in -ь (проверь is Russian). '
    + 'Make adjectives agree with the gender of their noun (воден стрес, not водна стрес). '
    + 'Use the ordinary Bulgarian agronomic word for a thing, not a Russian cognate. '
    + 'Keep product names, brand names, chemical/active-ingredient names, units '
    + '(e.g. ha, kg, l, t/ha, mm, °C), codes and identifiers exactly as given; do not transliterate them. '
    + BULGARIAN_REGISTER_RULE;


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
            BULGARIAN_PROSE_RULES
        );
    }
    return '';
}

/**
 * The same rules, phrased CONDITIONALLY — for a surface that answers in the
 * language of the QUESTION rather than in a locale resolved up front (#3090).
 *
 * The assistant is that surface, and it had none of these. It carried one line
 * of its own, "Answer in the language of the question", which gets the
 * language roughly right and none of the anti-drift protection above.
 *
 * It is a STATIC string, and that is the point rather than an accident. The
 * assistant's system block is prompt-cached at ~80-86% read; a
 * locale-dependent suffix would split that cache per locale AND need a
 * `User.uiLanguage` read inside the request's hot path. The model already
 * knows which language it is answering in, so the instruction does not have
 * to — a conditional sentence costs a few tokens and keeps one cache entry.
 */
export const CONDITIONAL_BULGARIAN_PROSE_RULE =
    'If any part of your answer is in Bulgarian, these rules apply to it. ' + BULGARIAN_PROSE_RULES;

/**
 * Append the language instruction to an existing system prompt. Convenience
 * for the common "system string + one extra line" shape. Returns `system`
 * unchanged for English (or an empty instruction).
 */
export function withLocaleInstruction(system: string, locale: Locale | string | null | undefined): string {
    const line = localeOutputInstruction(locale);
    return line ? `${system}\n\n${line}` : system;
}
