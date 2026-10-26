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
/**
 * The register's own resolution: дка to two decimals, i.e. 0.001 ha.
 *
 * Both comparisons in this module round here, because #2308 settled that a
 * difference the document cannot print is not a difference.
 */
const asPrintedDca = (ha: number) => Math.round(haToDca(ha) * 100) / 100;

export function exceedsParcel(treatedAreaHa: number, parcelAreaHa: number): boolean {
    return asPrintedDca(treatedAreaHa) > asPrintedDca(parcelAreaHa);
}

/**
 * Are two treated areas the SAME, as the register can express them? (#2388)
 *
 * The same resolution and the same argument as `exceedsParcel` above, applied to
 * equality instead of to a bound — which is the other half of #2308's ruling and
 * was missed when that one shipped.
 *
 * ## What comparing exactly was costing
 *
 * Both correction routes compared with `!==`, so a client re-sending a RETAINED
 * area was told it had changed. Two causes, measured:
 *
 *   - **Float noise.** `haToDca` is `×10` and `dcaToHa` is `÷10`, and 9.58% of
 *     the four-decimal hectare values a `Decimal(12,4)` column can hold do not
 *     survive that round trip — `0.0017` comes back `0.0016999999999999997`.
 *     `rate-calc.ts` claimed in its own docblock that the round trip was exact;
 *     it is not, and that claim is now corrected there.
 *   - **Display rounding**, which is the larger one and was raised by the
 *     agrent-ios session. An area field shows дка to two places, which is
 *     hectares to THREE, so a stored `1.2346 ha` comes back from the field as
 *     `1.235 ha`. That differs at the column's own precision, so it read as a
 *     change AND was written — replacing a figure the farmer never edited.
 *
 * Either way the correction stopped being a no-op: it wrote a
 * `TreatmentCorrection` row naming `treatedAreaHa` on a parcel nobody touched,
 * and bumped the group version, invalidating any `If-Match` another client held.
 * On a record a farmer signs.
 *
 * ## Why this is not a loosening
 *
 * The same sentence `exceedsParcel` earns: it is a correction of UNITS, not of
 * strictness. A parcel's area is written in дка to two places on the document,
 * so a fourth-decimal hectare difference is not a correction the register can
 * record — there is no state of the document in which it is visible. Treating it
 * as one invents a correction.
 *
 * Measured against the cases that matter: `0.0017` vs its round trip and
 * `1.2346` vs `1.235` both read as SAME, while `1.234` vs `1.235` — one дка
 * hundredth apart, which the document CAN print — still reads as a change.
 *
 * `null` is "the area is not known" and is only equal to itself. It is not the
 * same statement as a number, however small: a stored NULL prints the parcel's
 * own area, so moving between them changes the document.
 */
export function sameTreatedArea(a: number | null, b: number | null): boolean {
    if (a === null || b === null) return a === b;
    return asPrintedDca(a) === asPrintedDca(b);
}
