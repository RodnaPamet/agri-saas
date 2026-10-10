/**
 * The season a typed cost and a planting are talking about.
 *
 * #1530's exclusivity rule is keyed on (commodity, season), so these keys
 * decide which consumption cost a typed figure replaces. Every failure here
 * is a WRONG ANSWER about money:
 *
 *   · a cost that resolves to the wrong season supersedes the wrong year's
 *     measured consumption, and both figures still look plausible;
 *   · an untagged "no season" key shared across years makes a 2024 cost
 *     silence a 2026 planting;
 *   · an exclusive end bound drops the last day of every season into the
 *     fallback, which is one wrong day per season and invisible.
 */
import {
    costSeasonKey,
    cropSeasonKey,
    plantingSeasonKey,
    seasonKeyOf,
    yearKeyOf,
    type SeasonWindow,
} from '@/lib/grain/cost-season-key';

const season = (id: string, from: string, to: string): SeasonWindow => ({
    id,
    startDate: new Date(from),
    endDate: new Date(to),
});

const S2026 = season('s26', '2025-09-01T00:00:00Z', '2026-08-31T23:59:59Z');
const S2025 = season('s25', '2024-09-01T00:00:00Z', '2025-08-31T23:59:59Z');
const SEASONS = [S2025, S2026];

const cost = (incurredOn: string, seasonId: string | null = null) => ({
    seasonId,
    incurredOn: new Date(incurredOn),
});

describe('costSeasonKey', () => {
    it('an explicit seasonId WINS over the date', () => {
        // An answer the farmer gave beats one the server inferred — even when
        // the date would resolve elsewhere, which this case deliberately does.
        expect(costSeasonKey(cost('2026-03-01T00:00:00Z', 's25'), SEASONS)).toBe(seasonKeyOf('s25'));
    });

    it('falls to the Season whose window CONTAINS the date', () => {
        expect(costSeasonKey(cost('2026-03-01T00:00:00Z'), SEASONS)).toBe(seasonKeyOf('s26'));
        expect(costSeasonKey(cost('2025-03-01T00:00:00Z'), SEASONS)).toBe(seasonKeyOf('s25'));
    });

    it('both bounds are INCLUSIVE', () => {
        // An exclusive end would push the last day of every season into the
        // year fallback, where it stops superseding the plantings it was typed
        // for. One wrong day per season, and nothing would look wrong.
        expect(costSeasonKey(cost('2025-09-01T00:00:00Z'), SEASONS)).toBe(seasonKeyOf('s26'));
        expect(costSeasonKey(cost('2026-08-31T23:59:59Z'), SEASONS)).toBe(seasonKeyOf('s26'));
    });

    it('falls back to the CALENDAR YEAR when no season contains the date', () => {
        expect(costSeasonKey(cost('2030-05-01T00:00:00Z'), SEASONS)).toBe(yearKeyOf(2030));
    });

    it('with NO seasons at all, every cost keys to its year', () => {
        // The common case on a farm that has not defined seasons, and the
        // default the unit tests run under.
        expect(costSeasonKey(cost('2026-03-01T00:00:00Z'), [])).toBe(yearKeyOf(2026));
    });

    it('uses UTC, not the runner local year', () => {
        // `getFullYear()` would read the machine's zone and put a 1 January
        // cost in the previous season on any runner behind UTC — green in
        // Sofia, red in CI, or the other way round.
        expect(costSeasonKey(cost('2026-01-01T00:30:00Z'), [])).toBe(yearKeyOf(2026));
        expect(costSeasonKey(cost('2026-12-31T23:30:00Z'), [])).toBe(yearKeyOf(2026));
    });

    it('resolves OVERLAPPING seasons deterministically', () => {
        // Nothing in the schema forbids two seasons covering one date, and a
        // rule that depended on row order would move money between refreshes.
        // Earliest start, then lowest id.
        const a = season('zzz', '2025-09-01T00:00:00Z', '2026-08-31T00:00:00Z');
        const b = season('aaa', '2025-10-01T00:00:00Z', '2026-09-30T00:00:00Z');
        const d = cost('2026-01-01T00:00:00Z');

        expect(costSeasonKey(d, [a, b])).toBe(seasonKeyOf('zzz'));
        // Order of the INPUT must not change the answer.
        expect(costSeasonKey(d, [b, a])).toBe(seasonKeyOf('zzz'));
    });

    it('breaks a start-date tie on the id', () => {
        const a = season('bbb', '2025-09-01T00:00:00Z', '2026-08-31T00:00:00Z');
        const b = season('aaa', '2025-09-01T00:00:00Z', '2026-08-31T00:00:00Z');
        const d = cost('2026-01-01T00:00:00Z');

        expect(costSeasonKey(d, [a, b])).toBe(seasonKeyOf('aaa'));
        expect(costSeasonKey(d, [b, a])).toBe(seasonKeyOf('aaa'));
    });
});

describe('plantingSeasonKey', () => {
    it('is the Season when the planting has one', () => {
        expect(plantingSeasonKey('s26')).toBe(seasonKeyOf('s26'));
    });

    it('is NULL with no season — it takes part in no supersession', () => {
        // Deliberately not a year: a planting has no date this module is given,
        // so inventing one would supersede on a guess.
        expect(plantingSeasonKey(null)).toBeNull();
        expect(plantingSeasonKey(undefined)).toBeNull();
    });
});

describe('the key space', () => {
    it('a SEASON key and a YEAR key never collide', () => {
        // The whole reason the keys are tagged. A plain nullable id would make
        // one "no season" key shared by every unseasoned cost and planting
        // across all years — so a typed 2024 cost would supersede a 2026
        // planting's consumption cost.
        expect(seasonKeyOf('2026')).not.toBe(yearKeyOf(2026));
    });

    it('two YEARS never collide', () => {
        expect(yearKeyOf(2025)).not.toBe(yearKeyOf(2026));
    });

    it('the crop+season key separates crops AND seasons', () => {
        const k = (c: string, s: string) => cropSeasonKey(c, s);

        expect(k('wheat', seasonKeyOf('s26'))).not.toBe(k('maize', seasonKeyOf('s26')));
        expect(k('wheat', seasonKeyOf('s26'))).not.toBe(k('wheat', seasonKeyOf('s25')));
        expect(k('wheat', seasonKeyOf('s26'))).toBe(k('wheat', seasonKeyOf('s26')));
    });
});
