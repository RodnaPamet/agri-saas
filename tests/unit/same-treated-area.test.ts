/**
 * Comparing two treated areas (#2388).
 *
 * The rule is #2308's, applied to equality instead of to a bound: a difference
 * the register cannot PRINT is not a difference. Worth its own file because both
 * correction routes compared exactly, and the two ways that went wrong are
 * measurable rather than theoretical.
 */
import { sameTreatedArea, exceedsParcel } from '@/lib/operations/printed-area';
import { haToDca, dcaToHa } from '@/lib/agro/rate-calc';

describe('sameTreatedArea', () => {
    it('absorbs the дка round trip, which is NOT exact', () => {
        // `rate-calc.ts` used to claim this round trip was unchanged. It is not:
        // 9.58% of four-decimal hectare values come back different, because ×10
        // then ÷10 is not an identity in binary floating point.
        const ha = 0.0017;
        const roundTripped = dcaToHa(haToDca(ha));
        expect(roundTripped).not.toBe(ha); // the premise — if this ever passes, the note above is stale
        expect(sameTreatedArea(ha, roundTripped)).toBe(true);
    });

    it('counts the round trip as lossy for ~1 value in 10 — the denominator and its RANGE', () => {
        // Stated as a number so the claim in the docblocks can be checked rather
        // than trusted — and the RANGE is stated with it, because the rate
        // depends on it and two figures without their axis look like a
        // contradiction.
        //
        // 0.0001..50.0000 ha is the range the docblocks quote (9.58%), chosen
        // because it is the span a parcel plausibly has. A narrower sample gives
        // a different rate for the same function: 0.0001..5.0000 gives ~12%.
        const run = (maxHa: number) => {
            const total = maxHa * 10_000;
            let lossy = 0;
            for (let i = 1; i <= total; i++) {
                const ha = i / 10_000;
                if (dcaToHa(haToDca(ha)) !== ha) lossy++;
            }
            return { lossy, total, pct: (100 * lossy) / total };
        };
        const wide = run(50);
        const narrow = run(5);
        console.log(
            `[same-area] lossy round trips: ${wide.lossy}/${wide.total} over 0.0001..50 ha `
                + `(${wide.pct.toFixed(2)}%); ${narrow.lossy}/${narrow.total} over 0.0001..5 ha `
                + `(${narrow.pct.toFixed(2)}%) — the rate follows the RANGE`,
        );
        // The docblocks' figure, pinned to its own range so a reword cannot
        // quietly move it.
        expect(wide.pct).toBeGreaterThan(9);
        expect(wide.pct).toBeLessThan(10);
    });

    it('absorbs DISPLAY rounding — a field showing дка to 2 places', () => {
        // The larger of the two causes, raised by agrent-ios. Their area field
        // shows дка to two decimals, which is hectares to three, so a stored
        // 1.2346 comes back 1.235 — a difference at the column's own precision,
        // which was both logged AND written.
        expect(sameTreatedArea(1.2346, 1.235)).toBe(true);
    });

    it('still sees a change the register CAN print', () => {
        // Not a blunt tolerance: one дка hundredth apart is 12.34 vs 12.35 on
        // the document, which is a real correction and must stay one.
        expect(sameTreatedArea(1.234, 1.235)).toBe(false);
        expect(sameTreatedArea(3.0, 3.5)).toBe(false);
        expect(sameTreatedArea(4.0, 4.1)).toBe(false);
    });

    it('treats null as "not known", equal only to itself', () => {
        // A stored NULL prints the parcel's own area, so moving between null and
        // a number changes the document however small the number is.
        expect(sameTreatedArea(null, null)).toBe(true);
        expect(sameTreatedArea(null, 0.0001)).toBe(false);
        expect(sameTreatedArea(0.0001, null)).toBe(false);
    });

    it('agrees with exceedsParcel about the resolution', () => {
        // Both live in one module and round at one place. If they ever disagree,
        // a value can be "the same as the parcel's area" and "larger than the
        // parcel" at once — which is how two documents start contradicting each
        // other about whether 32,48 дка fits in a 32,48 дка parcel.
        const parcel = 3.2478; // prints as 32,48 дка
        const typedBack = 3.248; // what 32,48 дка parses back to
        expect(exceedsParcel(typedBack, parcel)).toBe(false);
        expect(sameTreatedArea(typedBack, parcel)).toBe(true);
    });
});
