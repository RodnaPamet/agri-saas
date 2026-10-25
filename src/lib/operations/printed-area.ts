/**
 * Is a treated area larger than its parcel, AT THE RESOLUTION THE DOCUMENT PRINTS?
 *
 * Extracted from `diary-treatment.ts` for #2316: the bare-activity write path
 * needs the same bound, and a second copy of a rounding rule is how two
 * documents start disagreeing about whether 32,48 дка fits in a 32,48 дка
 * parcel.
 *
 * Shared with no change in behaviour — the comparison below is the one #2308
 * settled, moved rather than rewritten.
 */
import { haToDca } from '@/lib/agro/rate-calc';

/**
 * Does a submitted treated area exceed its parcel, AS THE REGISTER CAN EXPRESS IT?
 *
 * The bound used to be exact (`treatedAreaHa > areaHa`) while every surface
 * shows the area ROUNDED, so typing the displayed figure back was refused for a
 * rounding the farmer never made (#2308). A parcel of 3.2478 ha displays as
 * 32,48 дка — `haToDca` then `trimNumber`, which rounds to two places — and
 * 32,48 дка parses back to 3.248 ha, which is greater than 3.2478.
 *
 * So the comparison happens at the register's own resolution: дка to two
 * decimals, i.e. 0.001 ha. Both sides are rounded there, and only a difference
 * the register could actually print is a refusal. 32,48 vs 32,48 passes;
 * 41 дка against a 40 дка parcel still fails, as does 999 against 4.
 *
 * Not a loosening of the rule, a correction of its units: a treated area larger
 * than its parcel is still refused, and "larger" now means larger in the units
 * the document is written in.
 */
export function exceedsParcel(treatedAreaHa: number, parcelAreaHa: number): boolean {
    const asPrintedDca = (ha: number) => Math.round(haToDca(ha) * 100) / 100;
    return asPrintedDca(treatedAreaHa) > asPrintedDca(parcelAreaHa);
}
