/**
 * The vine card's published costs, and the one peg this repo still allows —
 * #637.
 *
 * ## What the owner actually ruled, in two parts
 *
 * 2026-11-06: euro everywhere. 2026-11-16: these МЗХ figures may be converted
 * and shown in euro. The second is a NARROW exception to the first, for
 * published reference data — and it had to be, because `1.95583` exists
 * nowhere as live code: #2793 removed it from four places on 2026-11-08, and
 * `normaliseCostToEur` now answers a `BGN` amount with `refusal: 'FOREIGN'`.
 *
 * So the assertions here are about a boundary, not just arithmetic. The figures
 * are stored as the card prints them, converted only on the way out, and
 * nothing about them may reach a path that refuses lev.
 *
 * ## Why the dataset stores a total it could compute
 *
 * Because then the five lines have something independent to be checked
 * against. It caught a real error during authoring — 4 177,79 лв transcribed
 * as `411779` rather than `417779` — which a total derived from the lines
 * could not have. The iOS session proposed that check; it is the reason
 * `publishedTotal` is in the schema.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { blankNonCode } from '../../helpers/blank-non-code';
import {
    BGN_PER_EUR,
    CALENDAR_COST_LINES,
    MAX_PUBLISHED_STOTINKI,
    perDaEurCents,
} from '@/lib/agro/calendar/costs';
import { CALENDAR, calendarFor, servedCosts, validateDataset } from '@/lib/agro/calendar/load';

/** The shipped dataset, deep-cloned so a mutation cannot leak between tests. */
const clone = () => JSON.parse(JSON.stringify(CALENDAR)) as Record<string, unknown>;

const vine = () => {
    const crop = CALENDAR.crops.find((c) => c.key === 'wine-grape');
    if (!crop?.costs) throw new Error('wine-grape has no costs block');
    return crop.costs;
};

describe('§1 the shipped figures are the card\'s figures', () => {
    it('[calendar-costs] the lines sum EXACTLY to the printed total', () => {
        const c = vine();
        const sum = c.lines.reduce((n, l) => n + l.published, 0);
        console.log(
            `[calendar-costs] ${c.lines.length} line(s), sum ${sum} стотинки, printed total `
            + `${c.publishedTotal}, basis ${c.basis.areaDa} дка`,
        );
        expect(sum).toBe(c.publishedTotal);
        // Integer стотинки throughout — no float anywhere to need a tolerance.
        for (const l of c.lines) expect(Number.isInteger(l.published)).toBe(true);
        expect(Number.isInteger(c.publishedTotal)).toBe(true);
    });

    it('is stored as PRINTED — lev, stotinki, for the card\'s own area', () => {
        const c = vine();
        expect(c.basis).toEqual({ areaDa: 100, currency: 'BGN', unit: 'stotinki' });
        // Nothing pre-divided: 4 177,79 лв is 417779, not 4178 per дка.
        expect(c.lines.find((l) => l.key === 'fuel')?.published).toBe(417779);
        expect(c.publishedTotal).toBe(11109297);
    });

    it('cites the vine card, and that source resolves', () => {
        const c = vine();
        expect(c.cite).toEqual({ source: 'mzh-tk-wine-2026', page: 9 });
        const src = CALENDAR.sources[c.cite.source];
        expect(src?.url).toContain('tk_vineni_lozia.pdf');
    });

    it('[calendar-costs] is the ONLY crop with costs — the other cards are blank templates', () => {
        const priced = CALENDAR.crops.filter((c) => c.costs).map((c) => c.key);
        console.log(`[calendar-costs] ${priced.length}/${CALENDAR.crops.length} crop(s) priced: ${priced.join(', ')}`);
        // МЗХ's 2024 field, vegetable, legume and perennial cards give
        // quantities only — every «Единична цена/Стойност» cell is empty — so
        // a costs block on any of them would be an estimate dressed as a
        // citation. If this count grows, a newly PRICED card is the only
        // legitimate reason.
        expect(priced).toEqual(['wine-grape']);
    });
});

describe('§2 the euro derivation', () => {
    it('divides once and rounds once, per line and for the total', () => {
        const c = vine();
        const expected: Record<string, number> = {
            fuel: 2136,
            materials: 16590,
            wagesWorkers: 30260,
            wagesMachineOperators: 2600,
            services: 5215,
        };
        for (const l of c.lines) {
            expect({ key: l.key, cents: perDaEurCents(l.published, c.basis.areaDa) })
                .toEqual({ key: l.key, cents: expected[l.key] });
        }
        expect(perDaEurCents(c.publishedTotal, c.basis.areaDa)).toBe(56801);
    });

    it('[calendar-costs] the rounded lines and the rounded total agree, MEASURED', () => {
        /*
         * The rule is: the total is rounded ONCE from `publishedTotal`, never
         * summed from the rounded lines, because the card states that total in
         * its own right.
         *
         * Rounding is not additive in general, so the two CAN differ. On this
         * card they do not — and that is worth pinning, because the API
         * description tells a client the two may differ by a cent or two, and
         * a reader checking today's numbers would otherwise find that claim
         * contradicted and "fix" something.
         */
        const c = vine();
        const area = c.basis.areaDa;
        const sumOfRounded = c.lines.reduce((n, l) => n + (perDaEurCents(l.published, area) ?? 0), 0);
        const totalRoundedOnce = perDaEurCents(c.publishedTotal, area);
        console.log(
            `[calendar-costs] sum of rounded lines ${sumOfRounded} vs total rounded once `
            + `${totalRoundedOnce} -> ${Math.abs(sumOfRounded - (totalRoundedOnce ?? 0))} cent(s) apart`,
        );
        expect(sumOfRounded).toBe(totalRoundedOnce);
    });

    it('rounds the TOTAL from publishedTotal, not from the rounded lines', () => {
        /*
         * THE RULE HAS NO TEETH ON THE REAL CARD, which is why this is
         * synthetic. Measured: on the vine figures the sum of the rounded
         * lines and the once-rounded total are both 56801, so a mutation that
         * replaced one with the other passed all sixteen tests. Rounding is
         * not additive in general; these values are a case where it shows.
         *
         * `publishedTotal` is a figure the card STATES. Building it out of
         * rounded parts would publish a number no page supports — the same
         * rule that stops us converting units or indexing prices — and on a
         * future card it would be visibly a cent off what the PDF prints.
         */
        const lines = [8991608, 1580240, 6136241, 974060, 8514358];
        const publishedTotal = lines.reduce((a, b) => a + b, 0);
        const synthetic = {
            basis: { areaDa: 100, currency: 'BGN', unit: 'stotinki' },
            cite: { source: 'mzh-tk-wine-2026', page: 9 },
            lines: CALENDAR_COST_LINES.map((key, i) => ({ key, published: lines[i] })),
            publishedTotal,
        } as Parameters<typeof servedCosts>[0];

        const out = servedCosts(synthetic);
        const summed = out.lines.reduce((n, l) => n + (l.perDaEurCents ?? 0), 0);

        // The two genuinely differ here, or this test proves nothing.
        expect(summed).toBe(133940);
        expect(out.perDaEurCentsTotal).toBe(133941);
        expect(out.perDaEurCentsTotal).not.toBe(summed);
    });

    it('refuses an unusable basis rather than dividing by zero', () => {
        for (const area of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(perDaEurCents(417779, area)).toBeNull();
        }
        expect(perDaEurCents(Number.NaN, 100)).toBeNull();
    });

    it('refuses a figure too large to convert EXACTLY, rather than losing precision', () => {
        // The guarantee integer arithmetic buys is exactness, so the one input
        // that would break it is refused instead of silently rounded by the
        // float path it no longer has. The vine card's largest figure is its
        // total, four orders of magnitude inside this bound.
        expect(perDaEurCents(MAX_PUBLISHED_STOTINKI, 100)).not.toBeNull();
        expect(perDaEurCents(MAX_PUBLISHED_STOTINKI + 1, 100)).toBeNull();
        expect(vine().publishedTotal).toBeLessThan(MAX_PUBLISHED_STOTINKI);
    });

    it('refuses a non-integer figure or area outright', () => {
        // Integer in, integer out. A fractional стотинка is not a thing the
        // card can print, and accepting one would reintroduce the float.
        expect(perDaEurCents(4177.79, 100)).toBeNull();
        expect(perDaEurCents(417779, 100.5)).toBeNull();
        expect(perDaEurCents(-1, 100)).toBeNull();
    });

    it('[calendar-costs] does the arithmetic in INTEGERS, not through the float peg', () => {
        /*
         * The house rule: "money is integer CENTS and rates are BASIS POINTS —
         * never a float". `BGN_PER_EUR` is a float and exists so the rate is
         * readable in one place; the computation uses `PEG_NUMERATOR` over
         * `PEG_SCALE` instead.
         *
         * Asserted on the SOURCE because the two forms agree on every figure
         * this card publishes — the agrent-ios session confirmed all six with
         * Decimal arithmetic — so no behavioural test can tell them apart. The
         * risk is a future edit reaching for the readable constant.
         */
        const src = fs.readFileSync(
            path.resolve(__dirname, '../../../src/lib/agro/calendar/costs.ts'),
            'utf8',
        );
        const body = src.slice(src.indexOf('export function perDaEurCents'));
        // The SHARED stripper: a local block-first one is refused by
        // `comment-stripper-order` (#1497), because a line comment containing
        // `/*` opens a fake block and eats the code after it.
        const code = blankNonCode(body, { strings: false });
        console.log(`[calendar-costs] perDaEurCents body: ${code.split('\n').length} line(s) of code`);
        expect(code).toContain('PEG_NUMERATOR');
        expect(code).toContain('PEG_SCALE');
        // The float must not appear in the function at all.
        expect(code).not.toContain('BGN_PER_EUR');
        expect(code).not.toMatch(/1\.95583/);
    });

    it('rounds half UP — pinned at the only kind of input that can show it', () => {
        /*
         * A mutation to half-DOWN passed every other test, and that is a
         * property of the arithmetic rather than a gap in them.
         *
         * At the card's basis of 100 дка the exact quotient can NEVER land on
         * a .5 boundary: it would need `2·st·100000 = odd·100·195583`, and
         * since `gcd(100000, 195583) = 1` with the peg odd, that forces
         * `st = odd × 97.7915` — not an integer. So for every figure any
         * 100-дка card can print, half-up and half-down agree, and the
         * direction is unobservable.
         *
         * It becomes observable at a contrived area, which is where the
         * direction gets pinned. The iOS session renders half-up, so the two
         * sides must agree on it even though today's data cannot reveal a
         * disagreement.
         */
        // Exactly 0.5 euro cents: 195583 стотинки over 200 000 дка.
        expect(perDaEurCents(195583, 200000)).toBe(1);
        // And a hair either side, so this is a boundary and not a constant.
        expect(perDaEurCents(195582, 200000)).toBe(0);
        expect(perDaEurCents(195584, 200000)).toBe(1);
    });

    it('uses the legally fixed rate, not a market one', () => {
        expect(BGN_PER_EUR).toBe(1.95583);
    });
});

describe('§3 the served shape carries both figures', () => {
    it('serves the published figure AND the derived euro one', () => {
        const [crop] = calendarFor({ region: 'south', crop: 'wine-grape' });
        expect(crop?.costs).toBeDefined();
        const served = crop.costs!;
        expect(served.perDaEurCentsTotal).toBe(56801);
        for (const l of served.lines) {
            // The published figure survives — it is the traceable one.
            expect(Number.isInteger(l.published)).toBe(true);
            // And the derived one is present, so no client needs the peg.
            expect(typeof l.perDaEurCents).toBe('number');
        }
        // Control: the keys served are exactly the closed set, in order.
        expect(served.lines.map((l) => l.key)).toEqual([...CALENDAR_COST_LINES]);
    });

    it('a crop with no costs serves no costs key at all', () => {
        // Not `costs: null` — absent. A null would read as "we looked and
        // there are none", where the truth is that МЗХ prices no such card.
        const [wheat] = calendarFor({ region: 'north', crop: 'wheat-bread' });
        expect(wheat).toBeDefined();
        expect('costs' in wheat).toBe(false);
    });
});

describe('§4 the loader REFUSES a bad costs block', () => {
    const withVineCosts = (patch: (c: Record<string, unknown>) => void) => {
        const d = clone();
        const crops = d.crops as Array<Record<string, unknown>>;
        const crop = crops.find((c) => c.key === 'wine-grape')!;
        patch(crop.costs as Record<string, unknown>);
        return d;
    };

    it('refuses lines that do not sum to the printed total', () => {
        const bad = withVineCosts((c) => {
            // The real authoring error: 417779 mistyped as 411779.
            (c.lines as Array<Record<string, unknown>>)[0].published = 411779;
        });
        expect(() => validateDataset(bad)).toThrow(/sum to 11103297 .* printed total is 11109297/s);
    });

    it('refuses a repeated line key, which would double-count into the sum', () => {
        const bad = withVineCosts((c) => {
            const lines = c.lines as Array<Record<string, unknown>>;
            // Keep the sum right so ONLY the duplicate check can catch it.
            lines.push({ key: 'fuel', published: 0 });
        });
        expect(() => validateDataset(bad)).toThrow(/repeats cost line\(s\): fuel/);
    });

    it('refuses a costs citation naming a source that is not in the map', () => {
        // The window loop never looked at `costs.cite`, so without the check
        // this block would look cited and resolve to nothing — the exact
        // failure the window citation check exists to prevent.
        const bad = withVineCosts((c) => {
            (c.cite as Record<string, unknown>).source = 'mzh-tk-wine-1999';
        });
        expect(() => validateDataset(bad)).toThrow(/citation\(s\) name a source that is not in the sources map/);
    });

    it('refuses a non-integer or negative published figure', () => {
        for (const v of [4177.79, -417779]) {
            const bad = withVineCosts((c) => {
                (c.lines as Array<Record<string, unknown>>)[0].published = v;
            });
            expect(() => validateDataset(bad)).toThrow(/malformed and will NOT be served/);
        }
    });

    it('refuses a currency or unit outside the closed set', () => {
        for (const [field, value] of [['currency', 'EUR'], ['unit', 'leva']] as const) {
            const bad = withVineCosts((c) => {
                (c.basis as Record<string, unknown>)[field] = value;
            });
            // EUR is REFUSED on purpose: the card prints lev, and relabelling
            // the stored figure as euro without dividing would overstate every
            // cost by 1.95583x.
            expect(() => validateDataset(bad)).toThrow(/malformed and will NOT be served/);
        }
    });

    it('CONTROL: the unmodified dataset still validates', () => {
        // Without this, every refusal above could be passing because the clone
        // is malformed for some unrelated reason.
        expect(() => validateDataset(clone())).not.toThrow();
    });
});
