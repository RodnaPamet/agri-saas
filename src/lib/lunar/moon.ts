/**
 * The Moon's phase and sidereal position for an instant (#3070).
 *
 * Numbers come from `astronomy-engine` (MIT, zero dependencies, pinned exactly),
 * not from a hand-rolled series. The reason is checkability rather than effort:
 * a Moon longitude wrong by one degree moves a sign boundary by about two hours,
 * and a series written here would have nothing independent to be wrong against.
 *
 * Nothing in this module is copied from a published calendar. The owner's
 * requirement (2026-11-15) is that the dates be COMPUTED, and an ephemeris
 * computation carries no one else's authorship.
 */
import { Body, EclipticGeoMoon, Illumination, MoonPhase } from 'astronomy-engine';

import { ayanamsaDegrees } from './ayanamsa';
import {
    DEGREES_PER_SIGN,
    normaliseDegrees,
    signOfSiderealLongitude,
    type DayType,
    type Sign,
    dayTypeOfSign,
} from './zodiac';

/** Waxing is new → full, waning is full → new. */
export type Phase = 'waxing' | 'waning';

/** The four quarters, reported by name so a client need not re-derive them. */
export type PhaseName = 'new' | 'waxingCrescent' | 'firstQuarter' | 'waxingGibbous'
    | 'full' | 'waningGibbous' | 'lastQuarter' | 'waningCrescent';

export interface MoonAt {
    /** Sun→Moon elongation in degrees, 0 at new and 180 at full. */
    readonly elongation: number;
    readonly phase: Phase;
    readonly phaseName: PhaseName;
    /** Illuminated fraction of the disc, 0..1. */
    readonly illumination: number;
    readonly siderealLongitude: number;
    readonly sign: Sign;
    readonly dayType: DayType;
}

/**
 * How close to an exact quarter counts as being AT it.
 *
 * The Moon's elongation moves ~12.2°/day, so 6° is about twelve hours either
 * side — which is what a calendar means by "new moon" on a date. Narrower and
 * the named phase would flip to a crescent for most of the day people call new.
 */
const QUARTER_WINDOW_DEG = 6;

function phaseNameOf(elongation: number): PhaseName {
    const e = normaliseDegrees(elongation);
    if (e < QUARTER_WINDOW_DEG || e > 360 - QUARTER_WINDOW_DEG) return 'new';
    if (Math.abs(e - 90) < QUARTER_WINDOW_DEG) return 'firstQuarter';
    if (Math.abs(e - 180) < QUARTER_WINDOW_DEG) return 'full';
    if (Math.abs(e - 270) < QUARTER_WINDOW_DEG) return 'lastQuarter';
    if (e < 90) return 'waxingCrescent';
    if (e < 180) return 'waxingGibbous';
    if (e < 270) return 'waningGibbous';
    return 'waningCrescent';
}

/** Everything this calendar needs about the Moon at one instant. */
export function moonAt(at: Date): MoonAt {
    // `MoonPhase` is the ecliptic elongation Sun→Moon in [0,360): 0 new,
    // 180 full. That single number gives both waxing/waning and the quarter,
    // so neither is derived from the illuminated fraction — which is ambiguous,
    // being equal either side of full.
    const elongation = normaliseDegrees(MoonPhase(at));
    const tropicalLon = EclipticGeoMoon(at).lon;
    const siderealLongitude = normaliseDegrees(tropicalLon - ayanamsaDegrees(at));
    const sign = signOfSiderealLongitude(siderealLongitude);
    return {
        elongation,
        phase: elongation < 180 ? 'waxing' : 'waning',
        phaseName: phaseNameOf(elongation),
        illumination: Illumination(Body.Moon, at).phase_fraction,
        siderealLongitude,
        sign,
        dayType: dayTypeOfSign(sign),
    };
}

/**
 * The instant the Moon crosses into its next sign, searched between two times.
 *
 * Bisection on the SIGN INDEX rather than on the longitude, because longitude
 * wraps at 360° and a numeric comparison across that wrap finds the wrong root.
 * Returns null when both ends are in the same sign.
 *
 * ~40 iterations takes a day-wide bracket to under a second, which is far finer
 * than this calendar can mean; the loop is bounded so a non-monotonic input
 * cannot spin.
 */
export function findSignChange(from: Date, to: Date): { at: Date; toSign: Sign } | null {
    const startSign = moonAt(from).sign;
    const endSign = moonAt(to).sign;
    if (startSign === endSign) return null;

    let lo = from.getTime();
    let hi = to.getTime();
    for (let i = 0; i < 40 && hi - lo > 1000; i += 1) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (moonAt(new Date(mid)).sign === startSign) lo = mid;
        else hi = mid;
    }
    const at = new Date(hi);
    return { at, toSign: moonAt(at).sign };
}

/** Degrees of a sign already traversed — used only for diagnostics. */
export function degreesIntoSign(siderealLongitude: number): number {
    return normaliseDegrees(siderealLongitude) % DEGREES_PER_SIGN;
}
