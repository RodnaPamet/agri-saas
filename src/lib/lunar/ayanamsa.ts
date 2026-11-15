/**
 * The tropical→sidereal offset, and why this feature needs one at all (#3070).
 *
 * The root / leaf / flower / fruit scheme this calendar rests on reads the Moon
 * against the ACTUAL constellations — the sidereal zodiac. The tropical zodiac
 * used in Western astrology is tied to the equinox, which precesses, and the
 * two have drifted roughly 24° apart: close to a whole sign.
 *
 * So the choice is not cosmetic. Computed tropically, nearly every day's type
 * would be shifted by about one sign from any sowing calendar a farmer already
 * owns, and the feature would look broken to exactly the people who use it.
 *
 * ## What this models, stated as a limit rather than a claim
 *
 * A Lahiri-STYLE ayanamsa as a linear fit: a value at J2000 plus a constant
 * precession rate. Over the decades this product will run, that is accurate to
 * about a hundredth of a degree, which is under a minute of the Moon's motion
 * (it moves ~0.55°/hour) and therefore immaterial to a day's classification.
 *
 * It is deliberately NOT a claim of bit-exact agreement with any particular
 * ephemeris house's Lahiri value. Those differ from each other in the third
 * decimal, and a sowing calendar cannot tell the difference. If exact agreement
 * with a named ephemeris is ever required, this is the one function to replace.
 */

/** Degrees per Julian year of general precession in longitude (≈50.29″/yr). */
export const PRECESSION_DEG_PER_YEAR = 0.0139694;

/** The fit's value at J2000.0 (2000-01-01T12:00:00Z). */
export const AYANAMSA_AT_J2000_DEG = 23.853;

const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
const MS_PER_JULIAN_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Degrees to SUBTRACT from a tropical ecliptic longitude to get the sidereal
 * one.
 *
 * Takes an instant rather than a year: the ayanamsa is continuous, and a
 * year-granular step would move every sign boundary by up to seven minutes on
 * 1 January for no reason.
 */
export function ayanamsaDegrees(at: Date): number {
    const years = (at.getTime() - J2000_MS) / MS_PER_JULIAN_YEAR;
    return AYANAMSA_AT_J2000_DEG + PRECESSION_DEG_PER_YEAR * years;
}
