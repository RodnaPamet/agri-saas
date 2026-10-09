/**
 * Pure news categoriser for the Trends → News tab.
 *
 * Every aggregated headline is bucketed into one of three categories the UI
 * filters by. The rule is deterministic — NO I/O, NO AI — so it unit-tests
 * without a network, exactly like `price-parse.ts`:
 *
 *   1. If the title/summary matches a POLICY keyword → 'policy'.
 *   2. Else if it matches a MARKET keyword → 'market'.
 *   3. Else the feed's own default category stands.
 *
 * Policy wins over market when both appear: a subsidy/regulation headline is
 * the more actionable classification for a Bulgarian farm operator than the
 * price angle it may also mention.
 *
 * Keywords are STEMS matched as case-insensitive substrings over
 * `title + ' ' + summary`, so a single Bulgarian stem (`субсиди`) catches every
 * inflection (субсидия / субсидии / субсидиите). Both Bulgarian (Cyrillic) and
 * English terms are listed because the EC agri press feed is English.
 *
 * @module lib/news/categorize
 */
import { COMMODITY_ALIASES } from '@/lib/market/commodity-vocabulary';

/** The three buckets the News tab filters by. Single source of truth — the
 *  Zod enum in `trends.schemas.ts` is built from this tuple. */
export const NEWS_CATEGORIES = ['market', 'policy', 'general'] as const;
export type NewsCategory = (typeof NEWS_CATEGORIES)[number];

/**
 * Policy / subsidy / regulation stems (BG + EN). Checked FIRST — the most
 * actionable classification for a farm operator (CAP deadlines, subsidy
 * windows, regulation changes).
 */
const POLICY_KEYWORDS: readonly string[] = [
    // Bulgarian
    'субсиди', // субсидия/субсидии
    'дфз', // Държавен фонд Земеделие
    'фонд земедели',
    'плащан', // директни плащания
    'регламент',
    'наредба',
    'директив',
    'еврофонд',
    'прср', // Програма за развитие на селските райони
    'осп', // Обща селскостопанска политика
    'министерств',
    'еко схем',
    'еко-схем',
    'грант',
    'подпомаган',
    // English
    'subsid',
    'cap ', // Common Agricultural Policy (trailing space avoids "capacity")
    'regulation',
    'directive',
    'ministry',
    'grant',
    'aid scheme',
    'eco-scheme',
    'eco scheme',
    'direct payment',
];

/**
 * Market / commodity / price stems (BG + EN). Checked SECOND — headlines that
 * move grain & oilseed prices (harvest, exports, market moves).
 */
const MARKET_KEYWORDS: readonly string[] = [
    // Bulgarian
    'цена', // цена/цени → both start "цен"
    'цени',
    'цен на',
    'реколт',
    'износ',
    'внос',
    'борса',
    'борсов',
    'пазар',
    'търгови', // търговия/търговски
    'зърно',
    'зърнен',
    'фючърс',
    'котировк',
    'тон', // цена на тон / тонаж
    'добив', // yield
    // English
    'price',
    'harvest',
    'export',
    'import',
    'market',
    'futures',
    'grain',
    'yield',
    'tonne',
];

// ─── Tags (#231) ────────────────────────────────────────────────────
//
// INCLUSIVE and unordered, unlike `categorize` below. That function is
// exclusive and priority-ordered — policy beats market — because one column
// forced a choice. Tags remove the forcing: a subsidy story about wheat
// carries BOTH `subsidies` and `wheat`, and there is no precedence to apply.
//
// `[]` is a real answer. An article matching no rule carries no tags, which is
// honest and is what the «Всички» switch keeps reachable.

/**
 * The crops the news feed tags, as commodity slugs.
 *
 * These ARE `CANONICAL_COMMODITIES` entries, and the aliases come from
 * `COMMODITY_ALIASES` rather than a keyword list written here. A parallel list
 * would not merely duplicate — it would DRIFT from the vocabulary #1444 taught
 * to resolve Bulgarian crop prefixes for Борса search, so a crop would become
 * findable in search and not in news, or the reverse, with nothing failing.
 * One vocabulary, one place to add a crop.
 */
export const CROP_TAGS = ['wheat', 'maize', 'sunflower', 'rapeseed', 'barley'] as const;

/**
 * Topic stems, matched as a PREFIX OF A WORD — see {@link matchesWordPrefix}.
 *
 * `subsidies` reuses `POLICY_KEYWORDS` wholesale: those stems already ARE
 * subsidy, regulation and payment terms, and a second list beside them would
 * be the same drift problem as a second crop list.
 *
 * `prices` is deliberately NARROWER than `MARKET_KEYWORDS`, and this is a
 * considered departure from the contract in
 * `docs/implementation-notes/2026-10-08-news-tags-and-preferences-contract.md`,
 * which called the two "near-duplicates". They should not be. `MARKET_KEYWORDS`
 * includes `реколт`, `износ`, `внос` and `добив` — harvest, export, import,
 * yield — and a farmer opting into «Цени» expecting price news would receive
 * every harvest story. The contract's goal was that `category` become
 * expressible as tags so it can eventually be dropped; `market` is still
 * expressible, just as a UNION of several tags rather than as one. Trading an
 * exact one-to-one mapping for a tag that means what its label says is the
 * right way round.
 *
 * A harvest story mentioning no price and no subsidy therefore gets its crop
 * tags and no topic tag. That is correct, not a gap.
 */
const TOPIC_STEMS: Readonly<Record<string, readonly string[]>> = {
    subsidies: POLICY_KEYWORDS,
    // «Пазар» — owner decision, 2026-10-09, confirmed directly.
    //
    // Slugged `trade`, NOT `market`, and the reason is a real collision:
    // `market` is already a NEWS_CATEGORIES value, so a tag of the same name
    // would make `?category=market` and `?tags=market` two different filters
    // sharing one word. The label is «Пазар» either way — slugs are stable
    // ASCII identifiers and the labels are authoritative (§2 of the contract).
    //
    // Distinct from `prices`, which owns price MOVEMENT (цена/борса/фючърс).
    // This is market STRUCTURE: who is buying, where it is going, trade
    // access. Tagging is inclusive (§3), so a story about export prices
    // legitimately carries both and that is the honest answer.
    //
    // `борса` deliberately stays in `prices` alone. It names the commodity
    // exchange specifically, which is a price surface in this product, and
    // duplicating it here would make every quote story a trade story too.
    trade: [
        // Covers пазар / пазарът / пазари / пазарен.
        'пазар',
        // `търгов`, not `търг`: it reaches търговия/търговски/търговец without
        // also reaching a bare «търг» (a tender), which is a procurement story
        // more often than a market one. Verified: «Търг за ремонт на пътя»
        // tags nothing.
        'търгов',
        // ── the definite forms ONLY, and the reason is measured ──
        //
        // A bare `износ` is a prefix of «износване» (wear), and `внос` of
        // «вноска» (a loan installment). Both were tried and both fired:
        // «Износването на гумите на трактора» and «Вноската по кредита е
        // платена» came back tagged `trade`. A PREFIX matcher cannot separate
        // them, so the indefinite forms are not listed at all.
        //
        // The cost is named rather than hidden: a headline written
        // «Износ на пшеница за Турция», with no article, is NOT tagged. That
        // is the deliberate trade — for a filter, an irrelevant article makes
        // the feature look broken, while a missed one is invisible.
        //
        // DO NOT add `износа` here. `matchesWordPrefix` runs every stem
        // through `stemOf` first, which strips a trailing vowel when ≥
        // MIN_STEM_LENGTH remains — so `износа` becomes `износ` and silently
        // restores the bug above. `износът` survives because it ends in a
        // consonant. `вноса` survives because trimming it leaves 4 characters,
        // under the floor.
        'износът',
        'вносът',
        'вноса',
        // English
        'market',
        'export',
        'import',
        'trade',
    ],
    prices: [
        // Bulgarian. `цена`/`цени`/`ценов` rather than the bare `цен`, which
        // is a prefix of `център` and would tag every story mentioning a
        // centre.
        'цена',
        'цени',
        'ценов',
        'поскъпв',
        'поевтин',
        'борса',
        'борсов',
        'фючърс',
        'котировк',
        // English
        'price',
        'futures',
        'quote',
        'tonne',
    ],
    weather: [
        'време',
        'дъжд',
        'суша',
        'засушав',
        'градушк',
        'слана',
        'температур',
        'прогноз',
        'валеж',
        'weather',
        'drought',
        'rainfall',
        'frost',
        'hail',
        'forecast',
    ],
    inputs: [
        // `тор` is safe as a word PREFIX — `фактор`, `директор` and `сектор`
        // contain it but do not start with it, which is the whole reason this
        // matcher is prefix-based rather than substring.
        'тор',
        'торов',
        'торене',
        'препарат',
        'пестицид',
        'хербицид',
        'фунгицид',
        'семена',
        'посевен',
        'fertilis',
        'fertiliz',
        'pesticide',
        'herbicide',
        'fungicide',
        'seed',
    ],
    machinery: [
        'техник',
        'трактор',
        'комбайн',
        'машин',
        'инвентар',
        'прикачн',
        'tractor',
        'combine',
        'machinery',
        'harvester',
        'implement',
    ],
    livestock: [
        'животновъдств',
        'говед',
        'свине',
        'свиневъдств',
        'овце',
        'овцевъдств',
        'птицевъдств',
        'мляко',
        'млечен',
        'livestock',
        'cattle',
        'swine',
        'sheep',
        'poultry',
        'dairy',
    ],
};

/** Letter runs, lowercased — the words a stem may prefix. */
function wordsOf(haystack: string): string[] {
    return haystack.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * True when any stem begins one of the words in `words`.
 *
 * PREFIX, not substring, and the distinction is load-bearing in both
 * languages. Substring matching fires mid-word: `dryer` contains `rye`,
 * `словесен` contains `овес`. Prefix matching cannot.
 *
 * But a whole alias is the wrong prefix to match, which a test caught after I
 * claimed otherwise. Bulgarian does not only APPEND a suffix — it REPLACES the
 * final vowel: `пшеницата` begins with `пшеница`, and `пшеници` does NOT. So
 * the matcher prefixes the alias's STEM, trimming one trailing vowel when what
 * remains is still long enough to be distinctive. `пшеница` -> `пшениц`
 * catches all three forms.
 *
 * `categorize` below keeps its own substring matcher and is unchanged. Its
 * stems are deliberately TRUNCATED (`субсиди`, `цен на`) and some contain
 * spaces, so substring is the right matcher for them; changing it would alter
 * a shipped classification. The two rules differ because the two vocabularies
 * do.
 *
 * What this cannot prevent is a longer word that genuinely BEGINS with a stem.
 * That is the same mechanism inflection relies on, so it is a trade rather
 * than a bug — and the stem list is the thing to check when a tag looks
 * over-broad.
 */
function matchesWordPrefix(words: readonly string[], stems: readonly string[]): boolean {
    const trimmed = stems.map(stemOf);
    return words.some((word) => trimmed.some((stem) => word.startsWith(stem)));
}

/**
 * Shortest distinctive prefix of `alias` — itself, or itself minus one
 * trailing vowel.
 *
 * Trimming is what makes `пшеници` match, since its final vowel differs from
 * `пшеница`'s. MIN_STEM_LENGTH bounds it. Measured over the five crops this
 * module actually tags, the split is:
 *
 *     пшеница (7) -> пшениц (6)    maize (5) -> maiz (4), FLOORED
 *     царевица (8) -> царевиц (7)  слънчоглед, ечемик: end in a consonant,
 *     рапица (6) -> рапиц (5)      so they are never trimmed at all
 *     canola (6) -> canol (5)
 *
 * ## An honest note on what the floor currently protects
 *
 * Only `maize` is floored, and `maiz` would prefix nothing else in the
 * corpus — so the floor FIRES but prevents no live collision. It is defence
 * for the next crop added, not a fix for a present one.
 *
 * I had justified it with `соя` -> `со` matching `социален` and `солта`, which
 * agrent backend-2 suggested pinning with a fixture. The fixture failed, and
 * for a better reason than either of us expected: **soybean is not one of the
 * five crops this module tags**, so `соя` is never consulted and that
 * collision cannot occur. The justification cited a vocabulary wider than the
 * one in use — the same one-level-off mistake that produced #1447's substring
 * test and #1465's two readings.
 *
 * So the floor stays, with its real reason stated: it is cheap, it is
 * exercised by `maize`, and `соя` becomes a live concern the moment soybean
 * joins CROP_TAGS — at which point the collision is real and this comment is
 * the warning.
 */
const MIN_STEM_LENGTH = 5;
const TRAILING_VOWEL = /[аеиоуъюяaeiou]$/u;

function stemOf(alias: string): string {
    if (!TRAILING_VOWEL.test(alias)) return alias;
    const trimmed = alias.slice(0, -1);
    return trimmed.length >= MIN_STEM_LENGTH ? trimmed : alias;
}

/**
 * Every tag an article carries — crops and topics, several of each, in a
 * stable sorted order.
 *
 * Deterministic, no I/O, no AI: the property that lets this unit-test without
 * a network, exactly as `categorize` does.
 */
/**
 * Every topic tag `deriveTags` can emit, derived from the keyword table rather
 * than restated beside it.
 *
 * The contract's own warning about the crop list applies here too: "a parallel
 * list would drift from the search vocabulary... the next person would update
 * one". `TOPIC_STEMS` is the vocabulary; this is a read of it.
 */
export const TOPIC_TAGS = Object.keys(TOPIC_STEMS).sort() as readonly string[];

/** Every tag in the vocabulary, crops and topics together. */
export const ALL_NEWS_TAGS: readonly string[] = [...CROP_TAGS, ...TOPIC_TAGS].sort();

export function deriveTags(title: string, summary: string | null | undefined): string[] {
    const words = wordsOf(`${title ?? ''} ${summary ?? ''}`);
    if (words.length === 0) return [];

    const tags = new Set<string>();

    for (const crop of CROP_TAGS) {
        const aliases = Object.entries(COMMODITY_ALIASES)
            .filter(([, slug]) => slug === crop)
            .map(([alias]) => alias);
        // The slug itself is not always an alias key, so it is matched in its
        // own right rather than assumed present in the table.
        if (matchesWordPrefix(words, [crop, ...aliases])) tags.add(crop);
    }

    for (const [topic, stems] of Object.entries(TOPIC_STEMS)) {
        if (matchesWordPrefix(words, stems)) tags.add(topic);
    }

    return [...tags].sort();
}

/** True when any stem in `stems` appears in the lowercased haystack. */
function matchesAny(haystack: string, stems: readonly string[]): boolean {
    return stems.some((stem) => haystack.includes(stem));
}

/**
 * Categorise one news item. `feedDefault` is used when no keyword matches —
 * it MUST already be a valid {@link NewsCategory} (the feed registry types it).
 */
export function categorize(
    title: string,
    summary: string | null | undefined,
    feedDefault: NewsCategory,
): NewsCategory {
    const haystack = `${title ?? ''} ${summary ?? ''}`.toLowerCase();
    if (matchesAny(haystack, POLICY_KEYWORDS)) return 'policy';
    if (matchesAny(haystack, MARKET_KEYWORDS)) return 'market';
    return feedDefault;
}
