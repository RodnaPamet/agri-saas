/**
 * The «Кампания» window — #2316.
 *
 * ## Why these tests pin INSTANTS rather than a duration
 *
 * A campaign contains both DST transitions, so "365 × 24h" is the kind of
 * assertion that passes for the wrong reason. What matters is that each bound
 * is the first instant of 1 October **as the farm sees it**, and the only way
 * to state that is the UTC instant it corresponds to.
 *
 * Ambient timezone cannot decide any of it: every expectation below is an
 * absolute instant, and the module reads `FARM_TIME_ZONE` explicitly rather
 * than the host's. `process.env.TZ` does not work inside Jest here anyway, so
 * a test that depended on the host zone could pass in CI for the wrong reason.
 */
import {
    campaignWindow,
    currentCampaignLabel,
    parseCampaignLabel,
    recentCampaignLabels,
    InvalidCampaignError,
    CAMPAIGN_START_MONTH,
} from '@/lib/reports/campaign-window';

/**
 * The first instant of 1 October `year` in Europe/Sofia, as a UTC instant:
 * 21:00 on 30 September, because the zone is GMT+3 then.
 *
 * Written `${year}-09-30` and not `${year - 1}-09-30` — that off-by-one year
 * was my first version and it failed against correct code, while the
 * independent "really is local midnight" assertion below passed. Two
 * expressions of the same fact, disagreeing, is what located the mistake in
 * the fixture rather than in the module.
 */
const FIRST_INSTANT_OF_OCT_1 = (year: number) => `${year}-09-30T21:00:00.000Z`;

describe('campaignWindow — 1 October to 30 September (#2316)', () => {
    it('starts at the first instant of 1 October in the FARM zone, not UTC', () => {
        const w = campaignWindow('2024-2025');
        expect(w.startsAt.toISOString()).toBe(FIRST_INSTANT_OF_OCT_1(2024));
        // The naive answer, and why it is wrong: UTC midnight on 1 October is
        // already 03:00 on the 1st in Sofia, so a window starting there omits
        // the first three hours of the campaign.
        expect(w.startsAt.toISOString()).not.toBe('2024-10-01T00:00:00.000Z');
    });

    it('ends EXCLUSIVELY at the first instant of the next campaign', () => {
        const w = campaignWindow('2024-2025');
        expect(w.endsAtExclusive.toISOString()).toBe(FIRST_INSTANT_OF_OCT_1(2025));
        // Not 23:59:59.999 on 30 September. A Task stamped in that final
        // millisecond would vanish from a regulated document for no reason a
        // reader could find.
        expect(w.endsAtExclusive.getUTCMilliseconds()).toBe(0);
    });

    it('the bound really is local midnight — one minute earlier is the previous day', () => {
        // The property the probe exists to produce, asserted directly rather
        // than via the offset that happens to apply.
        const { startsAt } = campaignWindow('2024-2025');
        const inZone = (d: Date) =>
            new Intl.DateTimeFormat('en-CA', {
                timeZone: 'Europe/Sofia',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
            }).format(d);
        expect(inZone(startsAt)).toMatch(/^2024-10-01,? 00:00$/);
        expect(inZone(new Date(startsAt.getTime() - 60_000))).toMatch(/^2024-09-30,? 23:59$/);
    });

    it('a row exactly ON the lower bound is inside, and ON the upper bound is not', () => {
        // Half-open is the whole point of an exclusive end; stating it here so
        // a later change to `<=` fails rather than silently double-counting a
        // Task at the seam between two campaigns.
        const a = campaignWindow('2024-2025');
        const b = campaignWindow('2025-2026');
        expect(a.endsAtExclusive.getTime()).toBe(b.startsAt.getTime());
    });

    it('spans the DST transitions without losing or gaining a day', () => {
        const w = campaignWindow('2024-2025');
        const days = (w.endsAtExclusive.getTime() - w.startsAt.getTime()) / 86_400_000;
        // 365 exactly: the window contains one fall-back and one spring-forward,
        // which cancel. Asserted as a CHECK on the probe, not as the definition
        // — if Bulgaria abolished seasonal changes this stays 365, and if a
        // bound ever landed on a transition it would not.
        expect(days).toBe(365);
    });

    it('October is the start month, stated once', () => {
        expect(CAMPAIGN_START_MONTH).toBe(10);
    });
});

describe('parseCampaignLabel', () => {
    it('accepts YYYY-YYYY with consecutive years', () => {
        expect(parseCampaignLabel('2024-2025')).toEqual({ startYear: 2024, endYear: 2025 });
        expect(parseCampaignLabel('  2024-2025  ')).toEqual({ startYear: 2024, endYear: 2025 });
    });

    it.each([
        ['2025-2024', 'reversed'],
        ['2024-2026', 'not consecutive'],
        ['2024-2024', 'the same year twice'],
        ['2024', 'a single year'],
        ['24-25', 'two-digit years'],
        ['2024/2025', 'the wrong separator'],
        ['', 'empty'],
        ['2024-2025-2026', 'three years'],
    ])('rejects %s (%s)', (label) => {
        expect(() => parseCampaignLabel(label)).toThrow(InvalidCampaignError);
    });

    it('names the likely intent when the years are not consecutive', () => {
        // A coded refusal an operator can act on beats a generic one: the
        // commonest mistake is a typo in the second year.
        expect(() => parseCampaignLabel('2024-2026')).toThrow(/did you mean 2024-2025/);
    });
});

describe('currentCampaignLabel — decided on the farm calendar day', () => {
    it.each([
        // Just before 1 Oct local: still the previous campaign.
        ['2025-09-30T20:59:59.999Z', '2024-2025'],
        // The first instant of 1 Oct local — 21:00 UTC on 30 September.
        ['2025-09-30T21:00:00.000Z', '2025-2026'],
        // Midwinter, when the offset is +2 rather than +3.
        ['2026-01-15T12:00:00.000Z', '2025-2026'],
        // The day before the next rollover.
        ['2026-09-30T20:00:00.000Z', '2025-2026'],
    ])('at %s the campaign is %s', (iso, expected) => {
        expect(currentCampaignLabel(new Date(iso))).toBe(expected);
    });

    it('rolls over on the farm clock, not the UTC one', () => {
        // 00:30 on 1 October in Sofia is still 21:30 on 30 September in UTC. A
        // picker reading UTC would disagree with the document for three hours
        // once a year, which is the kind of defect nobody reproduces.
        const justAfterLocalMidnight = new Date('2025-09-30T21:30:00.000Z');
        expect(currentCampaignLabel(justAfterLocalMidnight)).toBe('2025-2026');
        expect(justAfterLocalMidnight.toISOString().slice(0, 10)).toBe('2025-09-30');
    });
});

describe('recentCampaignLabels', () => {
    it('is newest-first and includes the current campaign', () => {
        expect(recentCampaignLabels(3, new Date('2026-01-15T12:00:00Z')))
            .toEqual(['2025-2026', '2024-2025', '2023-2024']);
    });

    it('refuses a non-positive or fractional count rather than returning []', () => {
        // An empty list would render a picker with no options and look like
        // "this farm has no campaigns", which is never true.
        for (const bad of [0, -1, 1.5, Number.NaN]) {
            expect(() => recentCampaignLabels(bad, new Date('2026-01-15T12:00:00Z')))
                .toThrow(InvalidCampaignError);
        }
    });
});
