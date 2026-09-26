/**
 * `sumCropArea` — the figure behind the "all your wheat here" chip.
 *
 * This number is what a farmer gets priced on, so every exclusion rule is
 * asserted rather than assumed: a crop that maps to nothing, and a parcel with
 * no recorded area, must not quietly enter the sum or the count.
 */
import { sumCropArea } from '@/lib/insurance';

describe('sumCropArea', () => {
    it('sums only the parcels whose crop maps to the product', () => {
        const total = sumCropArea(
            [
                { cropType: 'Wheat', areaHa: 10 },
                { cropType: 'Maize', areaHa: 50 },
                { cropType: 'Wheat', areaHa: 2.5 },
            ],
            'wheat',
        );
        expect(total).toEqual({ areaDca: 125, parcelCount: 2 });
    });

    it('counts free-text spellings through the same normalisation', () => {
        // Seed data really does carry "Winter Wheat"; an exact-match lookup
        // would preselect and sum nothing for most real parcels.
        const total = sumCropArea(
            [
                { cropType: 'Winter Wheat', areaHa: 10 },
                { cropType: 'wheat', areaHa: 10 },
                { cropType: 'Пшеница', areaHa: 10 },
            ],
            'wheat',
        );
        expect(total).toEqual({ areaDca: 300, parcelCount: 3 });
    });

    it('excludes a crop that maps to no product rather than guessing', () => {
        const total = sumCropArea(
            [
                { cropType: 'Grass', areaHa: 40 },
                { cropType: 'Wheat', areaHa: 10 },
            ],
            'wheat',
        );
        expect(total).toEqual({ areaDca: 100, parcelCount: 1 });
    });

    it.each([
        ['null', null],
        ['undefined', undefined],
        ['zero', 0],
        ['negative', -5],
        ['NaN', Number.NaN],
    ])('ignores a parcel whose areaHa is %s, in the count as well as the sum', (_label, areaHa) => {
        const total = sumCropArea(
            [
                { cropType: 'Wheat', areaHa: 10 },
                { cropType: 'Wheat', areaHa: areaHa as number | null | undefined },
            ],
            'wheat',
        );
        // The count must describe the parcels actually summed, or the chip
        // would say "2 parcels" over one parcel's area.
        expect(total).toEqual({ areaDca: 100, parcelCount: 1 });
    });

    it('returns a zero total for no match, so the caller can hide the chip', () => {
        expect(sumCropArea([{ cropType: 'Maize', areaHa: 10 }], 'wheat')).toEqual({
            areaDca: 0,
            parcelCount: 0,
        });
        expect(sumCropArea([], 'wheat')).toEqual({ areaDca: 0, parcelCount: 0 });
    });

    it('works for peril products too, which match no crop', () => {
        // `productForCrop` maps crops only, so a peril never aggregates — the
        // chip is hidden for hail/drought/frost by this alone.
        expect(sumCropArea([{ cropType: 'Wheat', areaHa: 10 }], 'hail')).toEqual({
            areaDca: 0,
            parcelCount: 0,
        });
    });

    it('rounds to 2dp so the chip, the field and the scope comparison agree', () => {
        // 3 × 1.15 ha = 3.4499999999999997 ha in IEEE754. Without the rounding
        // the chip would write one number and read back another, and a tapped
        // chip would derive as a hand edit.
        const total = sumCropArea(
            [
                { cropType: 'Wheat', areaHa: 1.15 },
                { cropType: 'Wheat', areaHa: 1.15 },
                { cropType: 'Wheat', areaHa: 1.15 },
            ],
            'wheat',
        );
        expect(total.areaDca).toBe(34.5);
        expect(String(total.areaDca)).toBe('34.5');
    });
});
