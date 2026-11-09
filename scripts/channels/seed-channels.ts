/**
 * Seed the platform's channel catalogue — P9.2 (#2936).
 *
 * Forty-three rows: ten crop channels, five input channels, twenty-eight
 * oblast channels. Idempotent by construction rather than by a flag — see
 * below.
 *
 * ## The catalogue is DERIVED from three existing sources, never retyped
 *
 * | channels | source | why that one |
 * |---|---|---|
 * | 10 crop | `CANONICAL_COMMODITIES` | the vocabulary `ExchangeListing` and the trends surface already speak |
 * | 5 input | `INPUT_COMMODITIES` | kept separate in that file on purpose; see the owner ruling below |
 * | 28 oblast | `BULGARIA_REGIONS` | ISO codes, Bulgarian names and centroids, the same codes `ExchangeListing.oblast` stores |
 *
 * `CropType` is the obvious source for the crop half and it is the WRONG one:
 * it is **tenant-scoped** (`tenantId String`, not nullable), so it is each
 * farm's own list and seeding from it would create a channel per farm per
 * crop. The join that makes suggestion work is `CropType.commodityCanonical`,
 * which points a farm's crop type at the canonical vocabulary this file reads.
 *
 * ## «15 crops» was 10 + 5, and the five are not crops
 *
 * The phase plan says "15 crops". Measured 2026-11-09: `CANONICAL_COMMODITIES`
 * has **ten** entries and `INPUT_COMMODITIES` has **five** — diesel, urea,
 * dap, map, ammonium-nitrate. Fuel and fertiliser.
 *
 * Owner ruling 2026-11-09: seed all fifteen, the five inputs as channels of
 * their own. The argument is `commodity-vocabulary.ts`'s own: *"fuel and
 * fertiliser are the two largest cash costs in an arable budget, and a farmer
 * deciding when to buy urea needs the same trend line a farmer deciding when
 * to sell wheat does."* A channel where farmers compare the quotes they are
 * being given is plausibly the most useful one here.
 *
 * ## THE KEY PREFIX IS LOAD-BEARING, not cosmetic
 *
 * An input channel is `TOPIC` with an `input:` key, never `CROP` with a
 * `crop:` key, because **suggestion treats the two differently**. A crop
 * channel is suggested to a farm that grows that crop — an equality join on
 * `CropType.commodityCanonical`. An input channel has no such join: every
 * arable farm buys diesel and fertiliser, so it is suggested to everybody or
 * to nobody. Keeping the prefix distinct lets one query tell them apart
 * without a second column.
 *
 * ## Idempotence is the UNIQUE INDEX, not a flag
 *
 * `Channel.key` is `@unique`, so a re-run is an upsert per row and there is no
 * `seeded` boolean for anybody to forget to set — the `NoticeScore.reportId`
 * precedent (#1596). It also means a renamed channel keeps its membership:
 * the key is the identity, the names are data.
 *
 * **The upsert deliberately does NOT touch `memberCount` or
 * `slowModeSeconds`.** Both are runtime state — one maintained by the join
 * path, the other set by an operator slowing a channel that is being flooded —
 * and a seed that reset them would undo an operator's action on every deploy.
 * Re-running this updates the NAMES and nothing else.
 *
 * ## It joins NOBODY
 *
 * This file writes no `ChannelMembership` row, and that is the whole point of
 * the issue rather than an omission. `tests/guards/channels-are-never-auto-joined.test.ts`
 * holds it, modelled on `no-auto-join` — which exists because a person finding
 * themselves in something they did not join is the defect, whether the thing
 * is a tenant or a channel.
 */
import type { PrismaClient } from '@prisma/client';

import { BULGARIA_REGIONS } from '../../src/lib/geo/bulgaria-regions';
import {
    CANONICAL_COMMODITIES,
    INPUT_COMMODITIES,
} from '../../src/lib/market/commodity-vocabulary';

/** How many channels the catalogue must produce. A FLOOR, and a reading. */
export const EXPECTED_CHANNEL_COUNT = 43;

/**
 * Bulgarian names for the ten canonical crops.
 *
 * Spelled out rather than derived: a commodity CODE is an identifier and a
 * channel NAME is copy a farmer reads. `COMMODITY_META` in the vocabulary
 * carries display labels for the market surface, and reusing them here would
 * tie a channel's name to a table heading — so the two can diverge
 * deliberately, and this map is where a channel's name is decided.
 */
const CROP_NAMES: Readonly<Record<string, { bg: string; en: string }>> = {
    wheat: { bg: 'Пшеница', en: 'Wheat' },
    maize: { bg: 'Царевица', en: 'Maize' },
    barley: { bg: 'Ечемик', en: 'Barley' },
    sunflower: { bg: 'Слънчоглед', en: 'Sunflower' },
    rapeseed: { bg: 'Рапица', en: 'Rapeseed' },
    oats: { bg: 'Овес', en: 'Oats' },
    rye: { bg: 'Ръж', en: 'Rye' },
    soybean: { bg: 'Соя', en: 'Soybean' },
    peas: { bg: 'Грах', en: 'Peas' },
    lentils: { bg: 'Леща', en: 'Lentils' },
};

/**
 * Bulgarian names for the five inputs.
 *
 * `dap` and `map` stay as the LETTERS. They are the trade abbreviations for
 * diammonium and monoammonium phosphate, and a Bulgarian farmer buys «ДАП» —
 * expanding them to «диамониев фосфат» would be a translation nobody uses at
 * a depot. Cyrillic rather than Latin because the surrounding copy is.
 */
const INPUT_NAMES: Readonly<Record<string, { bg: string; en: string }>> = {
    diesel: { bg: 'Дизел', en: 'Diesel' },
    urea: { bg: 'Урея', en: 'Urea' },
    dap: { bg: 'ДАП', en: 'DAP' },
    map: { bg: 'МАП', en: 'MAP' },
    'ammonium-nitrate': { bg: 'Амониева селитра', en: 'Ammonium nitrate' },
};

export interface SeedChannelRow {
    readonly key: string;
    readonly nameBg: string;
    readonly nameEn: string;
    readonly descriptionBg: string;
    readonly descriptionEn: string;
    readonly kind: 'CROP' | 'OBLAST' | 'TOPIC';
}

/**
 * The catalogue, as data. PURE and exported so a test can assert its shape
 * without a database — the count, the key prefixes, both locales present, and
 * no key repeated.
 */
export function channelCatalogue(): SeedChannelRow[] {
    const rows: SeedChannelRow[] = [];

    for (const commodity of CANONICAL_COMMODITIES) {
        const name = CROP_NAMES[commodity];
        if (!name) {
            // LOUD rather than skipped. A new canonical commodity with no
            // Bulgarian name would otherwise seed one fewer channel than the
            // vocabulary has, and the count would still look plausible.
            throw new Error(
                `No Bulgarian channel name for canonical commodity "${commodity}". `
                + 'Add it to CROP_NAMES — a channel seeded with an English name '
                + 'is a channel no farmer recognises.',
            );
        }
        rows.push({
            key: `crop:${commodity}`,
            nameBg: name.bg,
            nameEn: name.en,
            descriptionBg: `Обсъждане на ${name.bg.toLowerCase()} — сеитба, добиви, цени.`,
            descriptionEn: `${name.en} — sowing, yields and prices.`,
            kind: 'CROP',
        });
    }

    for (const input of INPUT_COMMODITIES) {
        const name = INPUT_NAMES[input];
        if (!name) {
            throw new Error(
                `No Bulgarian channel name for input commodity "${input}". `
                + 'Add it to INPUT_NAMES.',
            );
        }
        rows.push({
            // `input:`, never `crop:` — see the header. Suggestion joins a
            // crop channel to a farm's crops and cannot join an input channel
            // to anything, because every arable farm buys these.
            key: `input:${input}`,
            nameBg: name.bg,
            nameEn: name.en,
            descriptionBg: `${name.bg} — цени, наличности, кой какво плаща.`,
            descriptionEn: `${name.en} — prices, availability, what people are paying.`,
            // TOPIC rather than a fourth enum value: an input is not a crop,
            // and #2935's enum already carries the general case.
            kind: 'TOPIC',
        });
    }

    for (const region of BULGARIA_REGIONS.filter((r) => r.level === 'OBLAST')) {
        rows.push({
            key: `oblast:${region.code}`,
            nameBg: region.nameBg,
            nameEn: region.nameEn,
            descriptionBg: `Стопани от област ${region.nameBg}.`,
            descriptionEn: `Farmers in ${region.nameEn} oblast.`,
            kind: 'OBLAST',
        });
    }

    return rows;
}

export interface SeedChannelsResult {
    readonly created: number;
    readonly updated: number;
    readonly total: number;
}

/**
 * Write the catalogue. Idempotent: `Channel.key` is unique, so a re-run
 * updates names and creates nothing.
 *
 * Runs through the PRIVILEGED client. `Channel` has no `app_user` INSERT arm
 * by design (#2935) — a caller able to insert one could mint a channel
 * impersonating a crop or an oblast — so a seed is exactly the privileged
 * write path that policy anticipates.
 */
export async function seedChannels(prisma: PrismaClient): Promise<SeedChannelsResult> {
    const rows = channelCatalogue();
    if (rows.length !== EXPECTED_CHANNEL_COUNT) {
        // A derived catalogue that shrank is the failure this guards: 43 is
        // 10 + 5 + 28, and a source going empty would seed a plausible-looking
        // subset rather than erroring.
        throw new Error(
            `Catalogue produced ${rows.length} channel(s), expected `
            + `${EXPECTED_CHANNEL_COUNT}. A source list changed — update `
            + 'EXPECTED_CHANNEL_COUNT deliberately rather than letting a '
            + 'shrunken catalogue seed quietly.',
        );
    }

    const existing = new Set(
        (
            await prisma.channel.findMany({
                where: { key: { in: rows.map((r) => r.key) } },
                select: { key: true },
            })
        ).map((c) => c.key),
    );

    for (const row of rows) {
        await prisma.channel.upsert({
            where: { key: row.key },
            create: {
                key: row.key,
                nameBg: row.nameBg,
                nameEn: row.nameEn,
                descriptionBg: row.descriptionBg,
                descriptionEn: row.descriptionEn,
                kind: row.kind,
            },
            // NAMES ONLY. `memberCount` and `slowModeSeconds` are runtime
            // state — one maintained by the join path, the other an
            // operator's throttle — and resetting them here would undo an
            // operator's action on every deploy. `archivedAt` is left alone
            // for the same reason: a channel somebody archived must not
            // un-archive itself.
            update: {
                nameBg: row.nameBg,
                nameEn: row.nameEn,
                descriptionBg: row.descriptionBg,
                descriptionEn: row.descriptionEn,
                kind: row.kind,
            },
        });
    }

    return {
        created: rows.length - existing.size,
        updated: existing.size,
        total: rows.length,
    };
}
