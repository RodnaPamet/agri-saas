/**
 * The three invariants that keep input commodities honest.
 *
 * Trends now charts things the farm BUYS — diesel, urea, DAP, MAP,
 * ammonium nitrate — alongside the crops it sells. Three ways that can go
 * wrong quietly, in descending order of consequence:
 *
 *   1. A fuel or fertiliser slug reaching the EXCHANGE, so a farmer can
 *      list a tonne of diesel for sale on a grain exchange.
 *   2. An input slug with no Bulgarian alias, which does not fail — it
 *      SILENTLY SPLITS one series into two, and the commodity merely looks
 *      under-represented forever.
 *   3. A price source with no label, so a hand-typed number renders as
 *      "Other source" and is indistinguishable from a live quote.
 *
 * ── What these guards are and are not ────────────────────────────────
 *
 * Per CLAUDE.md's "Green is not the same as executed", a file under
 * `tests/guards/` that `readFileSync`s a source and matches a regex
 * executes the TEST, never the SUBJECT, and contributes zero runtime
 * coverage. Two of the three below therefore EXECUTE the subject instead
 * of scanning for it — `normalizeCommodity` and `sourceLabelKey` are pure
 * and importable, so asserting their behaviour is strictly stronger than
 * asserting their source text looks right. Only the wiring that has no
 * runtime surface (which resolver the exchange schema calls) is checked as
 * text.
 *
 * The arithmetic and parsing behind all of this is covered separately by
 * executing tests: `tests/unit/market/commodity-vocabulary.test.ts`,
 * `…/oil-bulletin-client.test.ts`, `…/world-bank-client.test.ts`,
 * `…/manual-prices.test.ts`, `…/xlsx.test.ts`.
 *
 * EACH GUARD CARRIES A MUTATION PROOF: the detector is run against a
 * planted violation and asserted to fire. A guard that only ever passes is
 * indistinguishable from one that cannot fail.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    CANONICAL_COMMODITIES,
    COMMODITY_ALIASES,
    INPUT_COMMODITIES,
    isInputCommodity,
    normalizeCommodity,
} from '@/lib/market/commodity-vocabulary';
import { sourceLabelKey } from '@/components/trends/trends-helpers';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

// ── 1. No input commodity may reach the exchange ─────────────────────

/**
 * The exchange's write schema must resolve user text through the CROP-ONLY
 * resolver. `normalizeAnyCommodity` accepts inputs by design — it is what
 * the price feeds use — so calling it here is the one edit that would open
 * the exchange to fertiliser without touching any list.
 */
function usesCropOnlyResolver(source: string): boolean {
    return !/normalizeAnyCommodity/.test(source);
}

describe('input commodities never reach the exchange', () => {
    // THE highest-consequence regression in this whole change.
    it('keeps CANONICAL_COMMODITIES free of every input slug', () => {
        for (const slug of INPUT_COMMODITIES) {
            expect(CANONICAL_COMMODITIES as readonly string[]).not.toContain(slug);
        }
    });

    // Executed, not scanned: this IS the function the exchange write schema
    // calls, so its behaviour is the actual guarantee.
    it('refuses every input slug and every input alias at the crop resolver', () => {
        for (const slug of INPUT_COMMODITIES) {
            expect(normalizeCommodity(slug)).toBeNull();
        }
        for (const [alias, slug] of Object.entries(COMMODITY_ALIASES)) {
            if (isInputCommodity(slug)) expect(normalizeCommodity(alias)).toBeNull();
        }
    });

    it('has the exchange write schema call the crop-only resolver', () => {
        const schema = read('src/app-layer/schemas/exchange.schemas.ts');
        expect(schema).toMatch(/normalizeCommodity/);
        expect(usesCropOnlyResolver(schema)).toBe(true);
    });

    it("builds the seller's dropdown from the crop list alone", () => {
        const modal = read('src/app/t/[tenantSlug]/(app)/exchange/CreateOfferModal.tsx');
        expect(modal).toMatch(/CANONICAL_COMMODITIES\.map/);
        expect(modal).not.toMatch(/INPUT_COMMODITIES|normalizeAnyCommodity/);
    });

    it('fires when the exchange schema is switched to the any-commodity resolver (mutation proof)', () => {
        const planted = `
            const CommodityField = z.string().transform((raw, ctx) => {
                const canonical = normalizeAnyCommodity(raw);
                if (!canonical) return z.NEVER;
                return canonical;
            });
        `;
        expect(usesCropOnlyResolver(planted)).toBe(false);
        // …and the real file still passes the same detector.
        expect(usesCropOnlyResolver(read('src/app-layer/schemas/exchange.schemas.ts'))).toBe(true);
    });
});

// ── 2. Every input slug has a Bulgarian alias ────────────────────────

/** Cyrillic, so a Bulgarian operator's spelling resolves rather than splitting. */
const CYRILLIC = /[Ѐ-ӿ]/;

function slugsMissingCyrillicAlias(
    slugs: readonly string[],
    aliases: Readonly<Record<string, string>>,
): string[] {
    const covered = new Set<string>();
    for (const [alias, slug] of Object.entries(aliases)) {
        if (CYRILLIC.test(alias)) covered.add(slug);
    }
    return slugs.filter((s) => !covered.has(s));
}

describe('every input commodity is spellable in Bulgarian', () => {
    // The vocabulary docblock is explicit: a missing alias does not fail, it
    // SILENTLY SPLITS a group. This product's operators write Bulgarian, and
    // an operator typing `нафта` must land on the same series as `diesel`.
    it('covers all five input slugs', () => {
        expect(slugsMissingCyrillicAlias(INPUT_COMMODITIES, COMMODITY_ALIASES)).toEqual([]);
    });

    // Executed: the alias table is one thing, resolving through the fold is
    // another, and only the second is what production does.
    it.each([
        ['нафта', 'diesel'],
        ['дизелово гориво', 'diesel'],
        ['карбамид', 'urea'],
        ['диамониев фосфат', 'dap'],
        ['моноамониев фосфат', 'map'],
        ['амониев нитрат', 'ammonium-nitrate'],
        ['амселитра', 'ammonium-nitrate'],
    ])('resolves %p to %p through the real fold', (spelling, slug) => {
        // The crop resolver must still refuse it — this is the input path.
        expect(normalizeCommodity(spelling)).toBeNull();
        const { normalizeAnyCommodity } = jest.requireActual<
            typeof import('@/lib/market/commodity-vocabulary')
        >('@/lib/market/commodity-vocabulary');
        expect(normalizeAnyCommodity(spelling)).toBe(slug);
    });

    it('fires when a slug loses its Bulgarian spelling (mutation proof)', () => {
        const stripped = Object.fromEntries(
            Object.entries(COMMODITY_ALIASES).filter(
                ([alias, slug]) => !(slug === 'diesel' && CYRILLIC.test(alias)),
            ),
        );
        expect(slugsMissingCyrillicAlias(INPUT_COMMODITIES, stripped)).toEqual(['diesel']);
        // …and the real table still passes.
        expect(slugsMissingCyrillicAlias(INPUT_COMMODITIES, COMMODITY_ALIASES)).toEqual([]);
    });
});

// ── 3. Every source the job writes has a label, in both locales ──────

/**
 * Source literals the pull job and the manual path actually persist.
 *
 * Scanned rather than listed, so a new `source:` in the job is picked up
 * without anyone remembering to update this file — which is the whole
 * failure mode: `manual`, `oil-bulletin` and `world-bank` each shipped as
 * "Other source" until they were labelled.
 */
function writtenSources(jobSource: string, manualSource: string): string[] {
    const found = new Set<string>();
    for (const m of jobSource.matchAll(/source:\s*'([a-z][a-z-]*)'/g)) found.add(m[1]);
    for (const m of jobSource.matchAll(/ecObservationsToItems\(\s*'([a-z][a-z-]*)'/g)) found.add(m[1]);
    for (const m of manualSource.matchAll(/MANUAL_SOURCE\s*=\s*'([a-z][a-z-]*)'/g)) found.add(m[1]);
    return [...found].sort();
}

function sourcesWithoutLabel(sources: readonly string[], en: string[], bg: string[]): string[] {
    return sources.filter((s) => {
        const key = sourceLabelKey(s);
        return key === 'other' || !en.includes(key) || !bg.includes(key);
    });
}

describe('every price source is named in the UI, in both locales', () => {
    const job = read('src/app-layer/jobs/market-prices-pull.ts');
    const manual = read('src/app-layer/usecases/market-manual-prices.ts');
    const sources = writtenSources(job, manual);
    const enKeys = Object.keys(JSON.parse(read('messages/en.json')).trends.sources);
    const bgKeys = Object.keys(JSON.parse(read('messages/bg.json')).trends.sources);

    it('finds the sources actually written (the scanner works)', () => {
        // A broken scanner would make every assertion below vacuous — the
        // classic way a structural guard rots into decoration.
        expect(sources).toEqual(
            expect.arrayContaining([
                'alpha-vantage',
                'barchart',
                'ec-agrifood',
                'listings',
                'manual',
                'oil-bulletin',
                'world-bank',
            ]),
        );
    });

    // Break: a hand-typed МАП price rendering as "Other source", which is
    // exactly what a farmer must never be shown for a number somebody typed.
    it('labels every one of them, in en AND bg', () => {
        expect(sourcesWithoutLabel(sources, enKeys, bgKeys)).toEqual([]);
    });

    it('fires on a source with no label key (mutation proof)', () => {
        expect(sourcesWithoutLabel([...sources, 'some-new-feed'], enKeys, bgKeys)).toEqual([
            'some-new-feed',
        ]);
    });

    it('fires when a label exists in en but not bg (mutation proof)', () => {
        const bgMissingManual = bgKeys.filter((k) => k !== 'manual');
        expect(sourcesWithoutLabel(sources, enKeys, bgMissingManual)).toEqual(['manual']);
        // …and both locales really do carry it today.
        expect(sourcesWithoutLabel(sources, enKeys, bgKeys)).toEqual([]);
    });
});
