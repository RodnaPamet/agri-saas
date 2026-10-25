/**
 * The «Кампания» window — the period the whole-farm ДНЕВНИК covers (#2316).
 *
 * A campaign runs **1 October to 30 September**, so «Кампания 2024–2025» is
 * 1 Oct 2024 → 30 Sep 2025. It is the agricultural year, not the calendar one.
 *
 * ## Why a campaign is DERIVED rather than stored
 *
 * `Season` can express any window, so a campaign-shaped Season is possible.
 * Measured in production 2026-10-25: **one Season exists**, it is the sample
 * dataset (`«2026 — примерен сезон»`), and its window is 1 Mar – 31 Oct — not
 * a campaign. A picker backed by Season rows would today offer one sample
 * season with the wrong dates, and on a tenant with no Seasons an empty list
 * for a period that self-evidently exists.
 *
 * A campaign is a pure function of a year. Deriving it needs no seeding step,
 * has no empty state, and nothing to keep in sync. `Season` stays what it is
 * for — planning.
 *
 * ## Why the bounds are PROBED in the zone, not computed from an offset
 *
 * Measured, because I first wrote the wrong reason here: **both bounds are
 * currently GMT+03:00.** 30 September is still EEST — the clocks go back on
 * the last Sunday of October, after the campaign has begun — so a hardcoded
 * `- 3h` would in fact produce the right answer today at both ends.
 *
 * That is exactly why it is not hardcoded. The constant would be correct for
 * the wrong reason, and three things would break it independently: the window
 * CONTAINS both transitions (back in late October, forward in late March), so
 * any arithmetic across it is unsafe; Bulgaria has an open legislative
 * question about abolishing seasonal changes, which would move one bound and
 * not the other; and a campaign that ever moved off 1 October could land on a
 * transition date itself.
 *
 * Probing is correct whichever offset applies, which is the property worth
 * having rather than a number that happens to hold in 2026.
 *
 * The approach is the one `quiet-hours.ts` already uses for the same reason:
 * anchor at **midday UTC**, which is inside the target calendar day in
 * `FARM_TIME_ZONE` whatever the offset (local 14:00 or 15:00), then walk to the
 * boundary reading the day key via `Intl`. No timezone arithmetic to get wrong.
 *
 * `@date-fns/tz` is NOT used, though it is present in `node_modules`: it
 * arrives only as a transitive dependency of `react-day-picker`, is absent
 * from `package.json`, and nothing else imports it. Depending on it directly
 * would break the day that package changes its own dependencies.
 *
 * ## The upper bound is EXCLUSIVE
 *
 * `endsAtExclusive` is the first instant of the NEXT campaign, so a row
 * belongs when `startsAt <= t < endsAtExclusive`. The alternative —
 * `23:59:59.999` on 30 September — invites the whole class of
 * millisecond-boundary bugs, and a `Task` stamped in that final millisecond
 * would vanish from a regulated document for no reason a reader could find.
 */
import { FARM_TIME_ZONE, dayKeyInTz } from '@/lib/calendar-day-key';

/** Campaigns begin on 1 October. */
export const CAMPAIGN_START_MONTH = 10;
export const CAMPAIGN_START_DAY = 1;

/** `YYYY-YYYY`, the two years consecutive. */
const LABEL = /^(\d{4})-(\d{4})$/;

export interface CampaignWindow {
    /** `2024-2025`, exactly as the caller passed it. */
    label: string;
    startYear: number;
    endYear: number;
    /** First instant of 1 October `startYear`, in the farm's zone. */
    startsAt: Date;
    /** First instant of 1 October `endYear` — EXCLUSIVE. */
    endsAtExclusive: Date;
}

export class InvalidCampaignError extends Error {}

/**
 * The first instant of local calendar day `YYYY-MM-DD` in `FARM_TIME_ZONE`.
 *
 * Probed, not computed. Walks back a minute at a time from midday UTC — the
 * safe anchor — until the day key changes, then returns the minute after that.
 * Local midnight is minute-aligned in every IANA zone this product serves, so
 * minute granularity lands exactly on it.
 */
function firstInstantOfLocalDay(y: number, m: number, d: number): Date {
    const target = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const anchor = Date.UTC(y, m - 1, d, 12, 0, 0, 0);

    // The anchor must really be inside the target day, or the walk below starts
    // in the wrong place and returns a boundary of the wrong date. Asserted
    // rather than assumed: it is the one premise the probe cannot recover from.
    if (dayKeyInTz(new Date(anchor), FARM_TIME_ZONE) !== target) {
        throw new InvalidCampaignError(
            `midday UTC on ${target} is not inside ${target} in ${FARM_TIME_ZONE} — `
                + `the zone's offset is outside the range this probe assumes.`,
        );
    }

    const MINUTE = 60_000;
    // 12h of anchor slack plus 4h for any plausible offset.
    for (let i = 1; i <= 16 * 60; i++) {
        const probe = anchor - i * MINUTE;
        if (dayKeyInTz(new Date(probe), FARM_TIME_ZONE) !== target) {
            return new Date(probe + MINUTE);
        }
    }
    // Unreachable: every local day has a first minute within 16h of midday UTC.
    // Thrown rather than defaulted, because a silently wrong window would
    // quietly omit or duplicate rows in a document a farmer signs.
    throw new InvalidCampaignError(
        `could not find the start of ${target} in ${FARM_TIME_ZONE} within 16h of midday UTC`,
    );
}

/** Parse and validate a `YYYY-YYYY` campaign label. */
export function parseCampaignLabel(label: string): { startYear: number; endYear: number } {
    const m = LABEL.exec(label.trim());
    if (!m) {
        throw new InvalidCampaignError(
            `campaign must look like YYYY-YYYY (e.g. 2024-2025); got ${JSON.stringify(label)}`,
        );
    }
    const startYear = Number(m[1]);
    const endYear = Number(m[2]);
    // Consecutive, and in that order. `2025-2024` and `2024-2026` are both
    // parseable and neither is a campaign; accepting either would produce a
    // document whose header and contents disagree about the period.
    if (endYear !== startYear + 1) {
        throw new InvalidCampaignError(
            `a campaign spans two CONSECUTIVE years, so ${label} is not one — `
                + `did you mean ${startYear}-${startYear + 1}?`,
        );
    }
    return { startYear, endYear };
}

/** The window for a `YYYY-YYYY` campaign label. */
export function campaignWindow(label: string): CampaignWindow {
    const { startYear, endYear } = parseCampaignLabel(label);
    return {
        label: label.trim(),
        startYear,
        endYear,
        startsAt: firstInstantOfLocalDay(startYear, CAMPAIGN_START_MONTH, CAMPAIGN_START_DAY),
        endsAtExclusive: firstInstantOfLocalDay(endYear, CAMPAIGN_START_MONTH, CAMPAIGN_START_DAY),
    };
}

/**
 * The campaign containing `now`, as a label.
 *
 * Decided on the farm's calendar day rather than UTC: at 00:30 on 1 October
 * the farm is in the new campaign while UTC is still on 30 September, and a
 * picker that disagreed with the document for three hours a year is worse than
 * one that is simply wrong.
 */
export function currentCampaignLabel(now: Date = new Date()): string {
    const [y, m] = dayKeyInTz(now, FARM_TIME_ZONE).split('-').map(Number);
    const startYear = m >= CAMPAIGN_START_MONTH ? y : y - 1;
    return `${startYear}-${startYear + 1}`;
}

/** The `count` most recent campaigns, newest first, including the current one. */
export function recentCampaignLabels(count: number, now: Date = new Date()): string[] {
    if (!Number.isInteger(count) || count < 1) {
        throw new InvalidCampaignError(`count must be a positive integer; got ${count}`);
    }
    const current = Number(currentCampaignLabel(now).slice(0, 4));
    return Array.from({ length: count }, (_, i) => `${current - i}-${current - i + 1}`);
}
