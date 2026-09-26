import { MAX_AREA_DCA, MAX_SUM_INSURED_CENTS } from './premium';

/**
 * Two locale-tolerant parsers, deliberately ASYMMETRIC.
 *
 * Bulgarian users type "100 000", "100 000,50" or "100.000"; English users
 * type "100,000.50". The asymmetry between money and area below is the point
 * of this file, and each parser carries the reason on itself.
 */

/** Spaces used as thousands separators, including the two non-breaking kinds. */
const SEPARATOR_SPACES = /[\s  ]/g;

/** Groups of exactly three digits, which is what a thousands separator implies. */
function groupsOfThree(parts: string[]): boolean {
    if (parts.length < 2) return false;
    if (parts[0].length < 1 || parts[0].length > 3) return false;
    return parts.slice(1).every((p) => p.length === 3);
}

/**
 * Parse a money amount to integer cents.
 *
 * The load-bearing decision is the single-separator case: "100.000" and
 * "100,000" BOTH mean one hundred thousand. Nobody insures a crop for €100.000
 * meaning one hundred euros, and reading it as a decimal would quote a premium
 * 1 000x too small — a silent, expensive wrong answer rather than an error.
 * `parseAreaDca` reads the same character the opposite way, on purpose.
 */
export function parseMoneyToCents(raw: string, opts?: { symbol?: string }): number | null {
    if (typeof raw !== 'string') return null;
    let s = raw.trim();
    if (s === '') return null;

    for (const sym of ['€', opts?.symbol].filter(Boolean) as string[]) {
        if (s.startsWith(sym)) s = s.slice(sym.length).trim();
        if (s.endsWith(sym)) s = s.slice(0, -sym.length).trim();
    }
    s = s.replace(SEPARATOR_SPACES, '');
    if (s === '') return null;

    // A sign or exponent is a shape no one types into a sum-insured field; a
    // silent reinterpretation of "1e5" is worse than a refusal.
    if (!/^[0-9.,]+$/.test(s)) return null;

    const dots = (s.match(/\./g) ?? []).length;
    const commas = (s.match(/,/g) ?? []).length;

    let intPart: string;
    let decPart = '';

    if (dots > 0 && commas > 0) {
        // The LAST separator is the decimal one; the other groups thousands.
        const decSep = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
        const thouSep = decSep === '.' ? ',' : '.';
        const [head, ...rest] = s.split(decSep);
        if (rest.length !== 1) return null;
        decPart = rest[0];
        if (!/^[0-9]{1,2}$/.test(decPart)) return null;
        if (!groupsOfThree(head.split(thouSep))) return null;
        intPart = head.split(thouSep).join('');
    } else if (dots + commas === 0) {
        intPart = s;
    } else {
        const sep = dots > 0 ? '.' : ',';
        const parts = s.split(sep);
        if (parts.length > 2) {
            // Used more than once → thousands, in groups of exactly three.
            if (!groupsOfThree(parts)) return null;
            intPart = parts.join('');
        } else {
            const [head, tail] = parts;
            if (/^[0-9]{3}$/.test(tail) && /^[0-9]{1,3}$/.test(head)) {
                intPart = head + tail; // THOUSANDS — see the docblock.
            } else if (/^[0-9]{1,2}$/.test(tail)) {
                intPart = head;
                decPart = tail;
            } else {
                return null;
            }
        }
    }

    if (!/^[0-9]+$/.test(intPart)) return null;
    const cents = Number(intPart) * 100 + Number(decPart.padEnd(2, '0') || '0');
    if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_SUM_INSURED_CENTS) return null;
    return cents;
}

/**
 * Parse an area in decares.
 *
 * Here "," and "." are ALWAYS the decimal separator, never thousands — the
 * opposite of `parseMoneyToCents`. Cadastral areas are written "12,345 дка"
 * and those three decimals are real square metres, so reading them as a
 * thousands separator would inflate a 12-decare parcel to 12 345.
 */
export function parseAreaDca(raw: string): number | null {
    if (typeof raw !== 'string') return null;
    let s = raw.trim().replace(SEPARATOR_SPACES, '');
    if (s === '') return null;
    if (!/^[0-9]+([.,][0-9]{1,3})?$/.test(s)) return null;
    s = s.replace(',', '.');
    const value = Number(s);
    if (!Number.isFinite(value) || value <= 0 || value > MAX_AREA_DCA) return null;
    return value;
}
