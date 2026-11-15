/**
 * Sidereal sign → element → day type (#3070).
 *
 * The mapping is the traditional one the sowing calendar rests on, and the
 * three steps are kept apart because they are three different kinds of fact:
 * the SIGN is astronomy, the ELEMENT is the classical assignment, and the DAY
 * TYPE is the horticultural reading of it. Collapsing them into one table would
 * hide which step a future correction belongs to.
 */

export const SIGNS = [
    'aries',
    'taurus',
    'gemini',
    'cancer',
    'leo',
    'virgo',
    'libra',
    'scorpio',
    'sagittarius',
    'capricorn',
    'aquarius',
    'pisces',
] as const;
export type Sign = (typeof SIGNS)[number];

export const ELEMENTS = ['fire', 'earth', 'air', 'water'] as const;
export type Element = (typeof ELEMENTS)[number];

export const DAY_TYPES = ['fruit', 'root', 'flower', 'leaf'] as const;
export type DayType = (typeof DAY_TYPES)[number];

/** 30° per sign, Aries first — the sidereal convention. */
export const DEGREES_PER_SIGN = 30;

/**
 * Element by position, not by a name table.
 *
 * The classical cycle is fire, earth, air, water repeating from Aries, so the
 * element is `index % 4`. Written as the cycle rather than twelve entries
 * because twelve entries can disagree with themselves and four cannot.
 */
export function elementOfSign(sign: Sign): Element {
    return ELEMENTS[SIGNS.indexOf(sign) % 4];
}

/** The horticultural reading: each element governs one plant organ. */
const DAY_TYPE_BY_ELEMENT: Readonly<Record<Element, DayType>> = {
    fire: 'fruit',
    earth: 'root',
    air: 'flower',
    water: 'leaf',
};

export function dayTypeOfElement(element: Element): DayType {
    return DAY_TYPE_BY_ELEMENT[element];
}

export function dayTypeOfSign(sign: Sign): DayType {
    return dayTypeOfElement(elementOfSign(sign));
}

/** Normalise any longitude into [0, 360). */
export function normaliseDegrees(deg: number): number {
    return ((deg % 360) + 360) % 360;
}

/** The sign a SIDEREAL ecliptic longitude falls in. */
export function signOfSiderealLongitude(siderealLon: number): Sign {
    const index = Math.floor(normaliseDegrees(siderealLon) / DEGREES_PER_SIGN);
    // `normaliseDegrees` bounds the input, so the index is 0..11 by
    // construction; the clamp is for a NaN reaching this, which would
    // otherwise index `undefined` and surface as a missing translation key
    // rather than as a bad number.
    if (!Number.isFinite(index) || index < 0 || index > 11) {
        throw new Error(`sidereal longitude out of range: ${siderealLon}`);
    }
    return SIGNS[index];
}
