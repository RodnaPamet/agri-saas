/**
 * One farm-local day of the lunar calendar (#3070).
 *
 * ## A day is often TWO types, and saying so is the point
 *
 * The Moon crosses a sign boundary every ~2.3 days at an arbitrary hour, so a
 * calendar date frequently starts as one type and ends as another. Reporting
 * only a single type would silently round half the boundary days to whichever
 * instant the implementation happened to sample.
 *
 * So a day carries a DOMINANT type — read at farm-local noon, the middle of the
 * working day — plus the transition instants inside it. The phone renders
 * «корен до 14:20, после цвят» from that, which is what the owner asked for.
 *
 * ## The day is farm-local, via the existing helper
 *
 * `farmDayRange` bounds a `Europe/Sofia` day and is DST-correct — it re-reads
 * the zone offset rather than adding 86,400,000 ms, which is wrong on a 23- or
 * 25-hour day. Rolling that arithmetic again here would be a second spelling of
 * something this repo has already got right once.
 */
import { dayKeyInTz, farmDayRange, FARM_TIME_ZONE } from '../calendar-day-key';

import { findSignChange, moonAt, type MoonAt, type Phase, type PhaseName } from './moon';
import { adviceFor, CROP_GROUPS, type CropGroup, type Recommendation } from './rules';
import type { DayType, Element, Sign } from './zodiac';
import { dayTypeOfSign, elementOfSign } from './zodiac';

export interface LunarTransition {
    readonly at: Date;
    readonly toSign: Sign;
    readonly toDayType: DayType;
}

export interface LunarDay {
    /** `YYYY-MM-DD` in `FARM_TIME_ZONE`. */
    readonly date: string;
    readonly phase: Phase;
    readonly phaseName: PhaseName;
    readonly illumination: number;
    readonly sign: Sign;
    readonly element: Element;
    /** The type at farm-local noon — see the docblock. */
    readonly dayType: DayType;
    readonly transitions: readonly LunarTransition[];
    readonly recommendations: Readonly<Record<CropGroup, readonly Recommendation[]>>;
}

/** The timezone every date in this module is expressed in. */
export const LUNAR_TIME_ZONE = FARM_TIME_ZONE;

/**
 * At most this many sign changes are searched within one day.
 *
 * The Moon needs ~2.3 days to cross a sign, so a day holds at most one — but
 * the loop is bounded rather than trusting that, because an unbounded search on
 * a non-monotonic input is the kind of thing that only shows up in production.
 * Two is the ceiling a 25-hour day could ever justify.
 */
const MAX_TRANSITIONS_PER_DAY = 2;

export function lunarDay(dayKey: string): LunarDay {
    const { start, end } = farmDayRange(dayKey);
    // Noon is taken as the MIDPOINT of the actual local day rather than
    // `start + 12h`, so a 23- or 25-hour DST day is still read at its middle.
    const noon = new Date(start.getTime() + Math.floor((end.getTime() - start.getTime()) / 2));
    const at: MoonAt = moonAt(noon);

    const transitions: LunarTransition[] = [];
    let cursor = start;
    for (let i = 0; i < MAX_TRANSITIONS_PER_DAY; i += 1) {
        const change = findSignChange(cursor, end);
        if (!change) break;
        transitions.push({
            at: change.at,
            toSign: change.toSign,
            toDayType: dayTypeOfSign(change.toSign),
        });
        // Step past the boundary so the next search cannot re-find the same one.
        cursor = new Date(change.at.getTime() + 1000);
        if (cursor >= end) break;
    }

    const advice = adviceFor(at.dayType, at.phase);
    return {
        date: dayKey,
        phase: at.phase,
        phaseName: at.phaseName,
        illumination: at.illumination,
        sign: at.sign,
        element: elementOfSign(at.sign),
        dayType: at.dayType,
        transitions,
        recommendations: Object.fromEntries(
            CROP_GROUPS.map((g) => [g, advice[g]]),
        ) as Readonly<Record<CropGroup, readonly Recommendation[]>>,
    };
}

/**
 * Every day in `[from, to]` inclusive, as farm-local day keys.
 *
 * Bounded by the caller; the route caps the span. Stepping 36 hours and
 * re-reading the day key is the same device `farmDayRange` uses, for the same
 * reason: `+1` on a date string is wrong at a month boundary.
 */
export function lunarRange(fromKey: string, toKey: string, maxDays: number): LunarDay[] {
    const out: LunarDay[] = [];
    let key = fromKey;
    for (let i = 0; i < maxDays; i += 1) {
        out.push(lunarDay(key));
        if (key === toKey) return out;
        const { end } = farmDayRange(key);
        key = nextDayKey(end);
        if (key > toKey) return out;
    }
    return out;
}

/**
 * `end` IS the next day's local midnight, so a nudge forward labels it without
 * another offset calculation.
 */
function nextDayKey(endOfPreviousDay: Date): string {
    return dayKeyInTz(new Date(endOfPreviousDay.getTime() + 1000), FARM_TIME_ZONE);
}
