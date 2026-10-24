/**
 * The applied-quantity arithmetic (#2284).
 *
 * The case that matters is a PARTIAL treated area: every other input produces
 * the same answer before and after the fix, so a suite without one is green
 * either way. The first test here is the discriminator; the rest pin the
 * branches it must not have disturbed.
 */

import { computeAppliedQuantity, appliedAreaHa } from '@/lib/units/applied-quantity';

const RATE = { measure: 'RATE', key: 'l-per-ha' };
const LITRE = { measure: 'VOLUME', key: 'l' };
const MILLILITRE = { measure: 'VOLUME', key: 'ml' };

describe('computeAppliedQuantity — the treated area (#2284)', () => {
    it('a RATE dose over a PARTIAL area uses the TREATED area, not the parcel', () => {
        // 1 L/ha over 2 of a 10 ha block is 2 L. Before the fix this returned
        // 10 — the register printed 2 ha while the journal entry recorded ten
        // hectares' worth, and the iPhone has sent partial areas since 20 Oct.
        expect(
            computeAppliedQuantity({
                doseValue: 1,
                doseUnit: RATE,
                productUnit: LITRE,
                treatedAreaHa: 2,
                parcelAreaHa: 10,
            }),
        ).toBe(2);
    });

    it('a NULL treated area still means THE WHOLE PARCEL', () => {
        // The other half of the coalesce, and the reason the fallback is the
        // parcel area rather than zero. This is the operator path through
        // Задачи, where `treatedAreaHa` is always null.
        expect(
            computeAppliedQuantity({
                doseValue: 1,
                doseUnit: RATE,
                productUnit: LITRE,
                treatedAreaHa: null,
                parcelAreaHa: 10,
            }),
        ).toBe(10);
    });

    it('converts the rate numerator into the product stock unit', () => {
        // L/ha × ha = L, deducting into an mL lot scales ×1000 — over the
        // TREATED area, so the conversion and the fix compose.
        expect(
            computeAppliedQuantity({
                doseValue: 1,
                doseUnit: RATE,
                productUnit: MILLILITRE,
                treatedAreaHa: 2,
                parcelAreaHa: 10,
            }),
        ).toBe(2000);
    });

    it('a FLAT dose ignores both areas', () => {
        // Not a rate, so there is no area in the dimensions at all. Worth
        // pinning: making the area authoritative must not have leaked it into
        // the branch where it has no business.
        for (const [treated, parcel] of [
            [null, 10],
            [2, 10],
            [null, null],
        ] as Array<[number | null, number | null]>) {
            expect(
                computeAppliedQuantity({
                    doseValue: 5,
                    doseUnit: LITRE,
                    productUnit: LITRE,
                    treatedAreaHa: treated,
                    parcelAreaHa: parcel,
                }),
            ).toBe(5);
        }
    });

    it('falls back to the legacy multiply for a rate unit outside the catalogue', () => {
        // An unregistered unit keeps working exactly as it did — and now over
        // the treated area, which is the point: the fallback must not be a
        // second place where the old behaviour survives.
        expect(
            computeAppliedQuantity({
                doseValue: 3,
                doseUnit: { measure: 'RATE', key: 'puds-per-dessiatina' },
                productUnit: { measure: 'VOLUME', key: 'vedro' },
                treatedAreaHa: 2,
                parcelAreaHa: 10,
            }),
        ).toBe(6);
    });

    it('falls back to the bare dose for an unknown NON-rate unit', () => {
        expect(
            computeAppliedQuantity({
                doseValue: 3,
                doseUnit: { measure: 'VOLUME', key: 'vedro' },
                productUnit: { measure: 'VOLUME', key: 'vedro' },
                treatedAreaHa: 2,
                parcelAreaHa: 10,
            }),
        ).toBe(3);
    });

    it('a missing unit row does not throw', () => {
        // Both lookups can miss — `units.find(...)` returns undefined for a
        // unit id with no row — and this runs inside the completion
        // transaction, so a throw here would fail the whole mark.
        expect(
            computeAppliedQuantity({
                doseValue: 4,
                doseUnit: undefined,
                productUnit: undefined,
                treatedAreaHa: null,
                parcelAreaHa: 10,
            }),
        ).toBe(4);
    });

    it('rounds to four decimal places', () => {
        expect(
            computeAppliedQuantity({
                doseValue: 1 / 3,
                doseUnit: RATE,
                productUnit: LITRE,
                treatedAreaHa: 1,
                parcelAreaHa: 1,
            }),
        ).toBe(0.3333);
    });
});

describe('appliedAreaHa', () => {
    it('coalesces with ?? and not ||, so a ZERO treated area survives', () => {
        // `||` would fall through to the parcel area here and silently treat a
        // zero-area line as a whole-parcel application — the opposite of what
        // the column says. The schema requires `.positive()`, so a stored zero
        // should be impossible; this pins the operator that makes it impossible
        // to matter.
        expect(appliedAreaHa(0, 10)).toBe(0);
    });

    it('is 0 when neither area is recorded', () => {
        // Which makes the quantity 0 and suppresses the deduction downstream.
        // Load-bearing: a fixture without `areaHa` deducted nothing, and a test
        // asserting "the diary does not deduct" passed for the wrong reason
        // until the area was set.
        expect(appliedAreaHa(null, null)).toBe(0);
    });

    it('prefers the treated area whenever there is one', () => {
        expect(appliedAreaHa(2, 10)).toBe(2);
        expect(appliedAreaHa(null, 10)).toBe(10);
        expect(appliedAreaHa(2, null)).toBe(2);
    });
});
