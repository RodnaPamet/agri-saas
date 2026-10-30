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

const SPRAY_NS = 'locations.smart.sprayReason';
const DISEASE_NS = 'locations.smart.diseaseReason';

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
