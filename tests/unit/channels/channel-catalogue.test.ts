/**
 * The channel catalogue — P9.2 (#2936).
 *
 * `channelCatalogue()` is pure, so its shape is asserted without a database.
 * The database half (idempotence) is
 * `tests/integration/p9-2-seed-channels.test.ts`.
 *
 * ## The number is DERIVED, and the plan's number was wrong
 *
 * The phase plan says "15 crops, 28 oblasti". Measured 2026-11-09:
 * `CANONICAL_COMMODITIES` has **ten** entries and `INPUT_COMMODITIES` has
 * **five** — diesel, urea, dap, map, ammonium-nitrate, which are fuel and
 * fertiliser rather than crops. So "15 crops" was 10 + 5.
 *
 * Owner ruling 2026-11-09: seed all fifteen, the inputs as channels of their
 * own. 43 total. These assertions pin that reading so a future reader does not
 * have to re-derive it from two exports and a plan.
 */
import {
    channelCatalogue,
    EXPECTED_CHANNEL_COUNT,
} from '../../../scripts/channels/seed-channels';

describe('the channel catalogue', () => {
    const rows = channelCatalogue();

    it('produces exactly the expected population, and prints it', () => {
        const byKind = rows.reduce<Record<string, number>>((acc, r) => {
            acc[r.kind] = (acc[r.kind] ?? 0) + 1;
            return acc;
        }, {});
        console.log(
            `[channel-catalogue] ${rows.length} channel(s): `
            + Object.entries(byKind).map(([k, n]) => `${k}=${n}`).join(' '),
        );
        expect(rows).toHaveLength(EXPECTED_CHANNEL_COUNT);
        expect(byKind).toEqual({ CROP: 10, TOPIC: 5, OBLAST: 28 });
    });

    it('gives every key a distinct value — the identity the upsert turns on', () => {
        // `Channel.key` is `@unique`, so a duplicate here would make the seed
        // upsert the same row twice and silently produce one fewer channel.
        const keys = rows.map((r) => r.key);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('prefixes an INPUT channel with `input:`, never `crop:`', () => {
        // Load-bearing, not cosmetic: suggestion joins a crop channel to a
        // farm's `CropType.commodityCanonical`, and an input channel has no
        // such join because every arable farm buys diesel and fertiliser. The
        // prefix is what lets one query tell them apart without a second
        // column.
        const inputs = rows.filter((r) => r.kind === 'TOPIC');
        expect(inputs).toHaveLength(5);
        for (const row of inputs) {
            expect(row.key.startsWith('input:')).toBe(true);
        }
        expect(rows.filter((r) => r.key.startsWith('crop:'))).toHaveLength(10);
        expect(rows.filter((r) => r.key.startsWith('oblast:'))).toHaveLength(28);
    });

    it('carries a REAL Bulgarian name for every channel, not the English one', () => {
        // The check that matters: `bg` must be Cyrillic and differ from `en`.
        // A catalogue seeded with English names is the i18n failure
        // `i18n-completeness`'s untranslated check exists for, one layer out of
        // its reach — these are database rows, not `messages/` keys, so no
        // catalogue guard can see them.
        const CYRILLIC = /[Ѐ-ӿ]/;
        const offenders = rows.filter(
            (r) => !CYRILLIC.test(r.nameBg) || r.nameBg === r.nameEn,
        );
        expect(offenders.map((r) => r.key)).toEqual([]);
    });

    it('keeps DAP and MAP as the trade letters, in Cyrillic', () => {
        // Deliberate: they are the abbreviations for diammonium and
        // monoammonium phosphate, and a Bulgarian farmer buys «ДАП» at a
        // depot. Expanding them would be a translation nobody uses.
        expect(rows.find((r) => r.key === 'input:dap')?.nameBg).toBe('ДАП');
        expect(rows.find((r) => r.key === 'input:map')?.nameBg).toBe('МАП');
    });

    it('describes every channel in both locales', () => {
        for (const row of rows) {
            expect(row.descriptionBg.length).toBeGreaterThan(0);
            expect(row.descriptionEn.length).toBeGreaterThan(0);
            expect(row.descriptionBg).not.toBe(row.descriptionEn);
        }
    });

    it('spells no oblast code it did not read from the region list', () => {
        // The oblast half must be DERIVED. A hand-typed `BG-29` would seed a
        // channel for an oblast that does not exist, and the count would still
        // read as 43 if somebody had also dropped a real one.
        const codes = rows
            .filter((r) => r.kind === 'OBLAST')
            .map((r) => r.key.replace('oblast:', ''));
        for (const code of codes) {
            expect(code).toMatch(/^BG-(?:0[1-9]|1[0-9]|2[0-8])$/);
        }
        expect(new Set(codes).size).toBe(28);
    });
});
