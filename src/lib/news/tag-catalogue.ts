/**
 * The Новини tag catalogue — the vocabulary with its labels, for clients.
 *
 * ## Why labels live here and not in the clients
 *
 * Owner's decision, recorded in §2 of
 * `docs/implementation-notes/2026-10-08-news-tags-and-preferences-contract.md`:
 * neither client hard-codes the vocabulary. A tag added on the server appears
 * in the «Предпочитания» sheet without an app release, which is the whole
 * reason the catalogue is an endpoint rather than a constant.
 *
 * ## Why this is a read of the tagger, not a list beside it
 *
 * The contract makes the argument for crops — "a parallel list would drift
 * from the search vocabulary... the next person would update one" — and it
 * applies with equal force to labels. So `LABELS` is keyed by the tags
 * `deriveTags` can actually emit, and `tests/unit/news-tag-catalogue.test.ts`
 * fails if the two sets ever differ in either direction. Adding a topic to
 * `TOPIC_STEMS` without a label is a red build, not a tag that renders as a
 * slug on somebody's phone.
 *
 * ## Why this file is in `src/lib` and not in the route
 *
 * `tests/guards/no-hardcoded-ui-strings.test.ts` scans `src/app` and
 * `src/components`. These Bulgarian strings are server DATA — they travel in a
 * JSON response and are never rendered by this codebase — but a route file
 * holding them would be scanned and flagged. Keeping them in `lib` is both
 * architecturally right and the reason the guard stays quiet.
 *
 * ## `labelEn` is not a localisation mechanism
 *
 * It exists at agrent-ios' request for iOS Voice Control, which needs a
 * speakable English label; a slug reads badly out loud. `label` stays
 * Bulgarian and authoritative — §2 again. There is deliberately no third
 * language and no fallback chain, because this is not i18n.
 *
 * @module lib/news/tag-catalogue
 */
import { CROP_TAGS, TOPIC_TAGS } from './categorize';

/** One tag as a client receives it. */
export interface NewsTagEntry {
    key: string;
    label: string;
    labelEn: string;
}

/** One group as a client receives it. */
export interface NewsTagGroup {
    key: 'crops' | 'topics';
    label: string;
    labelEn: string;
    tags: NewsTagEntry[];
}

/**
 * Bulgarian and English labels for every tag in the vocabulary.
 *
 * The Bulgarian labels for crops are the farmer's words and are the same
 * spellings `COMMODITY_ALIASES` maps to these slugs — so the label a reader
 * sees on an article is the word they would type into Борса search. That
 * agreement is not enforced by a test because the alias table holds several
 * spellings per crop and only one of them is the label; it is noted here so
 * the next editor keeps it.
 */
const LABELS: Readonly<Record<string, { label: string; labelEn: string }>> = {
    // ── crops ──
    wheat: { label: 'Пшеница', labelEn: 'Wheat' },
    maize: { label: 'Царевица', labelEn: 'Maize' },
    sunflower: { label: 'Слънчоглед', labelEn: 'Sunflower' },
    rapeseed: { label: 'Рапица', labelEn: 'Rapeseed' },
    barley: { label: 'Ечемик', labelEn: 'Barley' },
    // ── topics ──
    subsidies: { label: 'Субсидии', labelEn: 'Subsidies' },
    prices: { label: 'Цени', labelEn: 'Prices' },
    weather: { label: 'Време', labelEn: 'Weather' },
    inputs: { label: 'Торове и препарати', labelEn: 'Inputs' },
    machinery: { label: 'Техника', labelEn: 'Machinery' },
    livestock: { label: 'Животновъдство', labelEn: 'Livestock' },
    // «Пазар» — owner decision, 2026-10-09. Slugged `trade` because `market`
    // is already a NEWS_CATEGORIES value; see the note in `categorize.ts`.
    trade: { label: 'Пазар', labelEn: 'Market' },
};

const GROUP_LABELS: Readonly<Record<'crops' | 'topics', { label: string; labelEn: string }>> = {
    crops: { label: 'Култури', labelEn: 'Crops' },
    topics: { label: 'Теми', labelEn: 'Topics' },
};

/**
 * Tags whose label is missing, in vocabulary order.
 *
 * Exported for the guard test rather than kept private, so the failure message
 * can name the tag instead of asserting on a count. An empty array is the only
 * acceptable value and the build enforces it.
 */
export function tagsMissingALabel(): string[] {
    return [...CROP_TAGS, ...TOPIC_TAGS].filter((tag) => !(tag in LABELS));
}

/** Labels with no tag behind them — the other direction of the same drift. */
export function labelsWithoutATag(): string[] {
    const vocabulary = new Set<string>([...CROP_TAGS, ...TOPIC_TAGS]);
    return Object.keys(LABELS).filter((key) => !vocabulary.has(key));
}

function entriesFor(keys: readonly string[]): NewsTagEntry[] {
    return keys.map((key) => {
        const found = LABELS[key];
        // Unreachable while the guard test passes. It throws rather than
        // falling back to the slug, because a slug rendered as a label is a
        // defect that looks like a translation bug on a phone and would be
        // diagnosed there rather than here.
        if (!found) throw new Error(`news tag '${key}' has no label — see tagsMissingALabel()`);
        return { key, label: found.label, labelEn: found.labelEn };
    });
}

/**
 * The catalogue, exactly as `GET /trends/news/tags` returns it.
 *
 * Pure and tenant-independent: the vocabulary is the server's, identical for
 * every farm, which is what lets the response be cached hard (§4). Deliberately
 * carries NO per-tag counts — a count varies with the tenant and with every
 * pull, so including one would make a 24h-cacheable document stale within
 * minutes. agrent-ios asked whether counts could be added; the honest place
 * for them is the feed response, which already knows the filtered set.
 */
export function newsTagCatalogue(): { groups: NewsTagGroup[] } {
    return {
        groups: [
            { key: 'crops', ...GROUP_LABELS.crops, tags: entriesFor(CROP_TAGS) },
            { key: 'topics', ...GROUP_LABELS.topics, tags: entriesFor(TOPIC_TAGS) },
        ],
    };
}
