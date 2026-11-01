/**
 * Render an agro reason for a PERSON, in their language (#2490).
 *
 * ## Why this exists when `reasonCodes` already did
 *
 * `rules.ts` returns both forms and documents the split: English sentences
 * "for AI/audit/notification consumers", codes "for i18n at the UI render
 * layer". Two of those three consumers are right to take English — the
 * copilot builds an English prompt and pins its OUTPUT language separately,
 * and the audit row's only reader is that prompt. The third is not: a push
 * notification is read by a farmer, and the product is Bulgarian.
 *
 * So this is the render step the notification path was missing, not a new
 * mechanism. The codes, the params and the Bulgarian strings were all already
 * there.
 *
 * ## It reuses the UI's keys rather than translating the sentences again
 *
 * `locations.smart.sprayReason.*` already holds all five spray sentences in
 * both locales, with the right `{wind}` / `{limit}` / `{temp}` placeholders,
 * and `SmartDefaultsBanner` renders them. A second copy under a notification
 * namespace would be the same sentence twice — and the two would drift, which
 * is the whole reason this repo keeps one catalogue per string.
 */
import { translateFor } from '@/lib/i18n/server-messages';
import type { Locale } from '@/lib/i18n/locales';

import type { DiseaseReason, SprayReason } from './rules';
import type { SoilReason } from '@/lib/soil/suitability';

const SPRAY_NS = 'locations.smart.sprayReason';
const DISEASE_NS = 'locations.smart.diseaseReason';
const SOIL_NS = 'locations.smart.soilReason';

/**
 * One reason, rendered. Falls back to `null` rather than to the key: this
 * value is interpolated into a sentence a person reads, and
 * «…за пръскане — locations.smart.sprayReason.windUnsuitable» is worse than
 * the same sentence with no detail at all.
 */
export async function renderSprayReason(
    locale: Locale,
    reason: SprayReason | undefined,
): Promise<string | null> {
    if (!reason) return null;
    const key = `${SPRAY_NS}.${reason.code}`;
    const out = await translateFor(locale, key, reason.params);
    return out === key ? null : out;
}

/** As `renderSprayReason`, for the disease codes added in #2490. */
export async function renderDiseaseReason(
    locale: Locale,
    reason: DiseaseReason | undefined,
): Promise<string | null> {
    if (!reason) return null;
    const key = `${DISEASE_NS}.${reason.code}`;
    const out = await translateFor(locale, key, reason.params);
    return out === key ? null : out;
}

/**
 * As `renderSprayReason`, for the soil-suitability codes added in #2509.
 *
 * **Drainage words are resolved BEFORE interpolation**, which is why this one
 * is not a two-line copy of its siblings. `drainageMismatch` carries the raw
 * enum (`well` | `moderate` | `poor`), and interpolating that straight into a
 * Bulgarian sentence would read «…предполага well-отцеждаща се почва…» — an
 * English word inside translated copy. So each is translated to a word first
 * and the sentence takes the words, exactly as the repo's email templates
 * resolve a string to a local const before interpolating it.
 *
 * A missing drainage word falls back to the RAW enum rather than to null: a
 * sentence with an untranslated word in it is worse than nothing only when the
 * reader cannot act on it, and «well» is still readable — whereas dropping the
 * whole reason would remove the finding itself.
 *
 * The USDA texture class (`Sand`, `Silty clay loam`, …) is interpolated AS IS,
 * and that is a deliberate limit rather than an oversight: all twelve are an
 * internationally recognised classification, and choosing their Bulgarian
 * pedological names is a terminology decision for the owner, not something to
 * invent inside a render helper. Noted on #2509.
 */
export async function renderSoilReason(
    locale: Locale,
    reason: SoilReason | undefined,
): Promise<string | null> {
    if (!reason) return null;

    const params: Record<string, string | number> = { ...reason.params };
    for (const field of ['actual', 'preferred'] as const) {
        const raw = params[field];
        if (typeof raw !== 'string') continue;
        if (!['well', 'moderate', 'poor'].includes(raw)) continue;
        const wordKey = `${SOIL_NS}.drainage.${raw}`;
        const word = await translateFor(locale, wordKey);
        params[field] = word === wordKey ? raw : word;
    }

    const key = `${SOIL_NS}.${reason.code}`;
    const out = await translateFor(locale, key, params);
    return out === key ? null : out;
}
