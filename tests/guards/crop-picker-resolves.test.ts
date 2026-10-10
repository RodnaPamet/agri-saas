/**
 * Every pickable crop must resolve to a commodity, and be labelled in both
 * locales.
 *
 * The cost entry form's `CROP` allocation basis (#1530) stores the CANONICAL
 * commodity, derived from the picked value through `normalizeCommodity` and
 * REFUSED at the wire if it does not resolve. So a crop added to the picker
 * that the vocabulary does not cover becomes an option a farmer can select and
 * then be refused on submit, after typing a whole cost.
 *
 * That failure is invisible to the type system: `CROP_PICKER_VALUES` is a list
 * of free-text `Parcel.cropType` spellings and `normalizeCommodity` takes any
 * string, so adding `'Lavender'` compiles, renders, and fails only at runtime
 * for the farmer who picks it.
 *
 * ## Why `isCanonicalCommodity` being false for all six is asserted, not fixed
 *
 * Measured: all six picker values are NON-canonical as typed, and all six
 * resolve. `Canola` resolves to `rapeseed` — a different word, not a case
 * fold. Both facts are load-bearing in opposite directions and it is worth
 * one assertion each:
 *
 *   · the journal's «Култура» filter compares RAW against `Parcel.cropType`,
 *     because that column holds these exact spellings (#1569). Normalising
 *     there would match nothing.
 *   · a `CROP` cost stores the canonical slug, because its figure is keyed by
 *     commodity and `Wheat` / `wheat` must not become two keys that each carry
 *     a cost for the same crop in the same season.
 *
 * So a change that made the picker values canonical would silently break the
 * journal filter, and a change that stopped them resolving would silently
 * break the cost basis. The pair is pinned here because neither surface can
 * see the other's requirement.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
    CROP_PICKER_VALUES,
    cropPickerCommodity,
    cropPickerValueFor,
    isCropPickerValue,
} from '@/lib/grain/crop-picker';
import { isCanonicalCommodity, normalizeCommodity } from '@/lib/market/commodity-vocabulary';

const ROOT = path.resolve(__dirname, '../..');

const messages = (locale: string): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${locale}.json`), 'utf8'));

describe('every pickable crop resolves to a commodity', () => {
    it('control: the list is non-trivial', () => {
        // Without this every `it.each` below ranges over nothing and agrees.
        expect(CROP_PICKER_VALUES.length).toBeGreaterThanOrEqual(6);
    });

    it.each(CROP_PICKER_VALUES)('%s resolves through normalizeCommodity', (crop) => {
        // The wire REFUSES a CROP cost whose commodity does not resolve, so an
        // unresolvable picker value is an option that cannot be submitted.
        expect(cropPickerCommodity(crop)).not.toBeNull();
    });

    it.each(CROP_PICKER_VALUES)('%s is NOT canonical as typed', (crop) => {
        // The journal filter depends on this: it compares raw against
        // `Parcel.cropType`. If a picker value ever became canonical as
        // spelled, somebody would reasonably "simplify" the two paths into
        // one and break whichever surface they did not test.
        expect(isCanonicalCommodity(crop)).toBe(false);
    });

    it('Canola resolves to rapeseed — a rename, not a case fold', () => {
        // The one value where the two vocabularies differ by more than case.
        // Asserted by name because a mapping table that quietly dropped the
        // alias would leave five of six still passing.
        expect(normalizeCommodity('Canola')).toBe('rapeseed');
    });

    it('the forward map is INJECTIVE, so the reverse one is well-defined', () => {
        // `cropPickerValueFor` inverts this map to prefill the cost form when
        // editing a CROP entry. Two picker values resolving to one commodity
        // would make that inverse a coin toss and the prefill would silently
        // show the wrong crop — so the collision fails HERE, where the cause
        // is visible, rather than in a form nobody is testing.
        const commodities = CROP_PICKER_VALUES.map(cropPickerCommodity);

        expect(new Set(commodities).size).toBe(CROP_PICKER_VALUES.length);
    });

    it.each(CROP_PICKER_VALUES)('%s round-trips through the reverse lookup', (crop) => {
        expect(cropPickerValueFor(cropPickerCommodity(crop))).toBe(crop);
    });

    it('the reverse lookup is empty-safe, not guessy', () => {
        // A row the API wrote with a commodity the web picker does not offer
        // must show EMPTY, not the nearest crop. Showing a crop the row does
        // not name is worse than showing none.
        expect(cropPickerValueFor('lavender')).toBe('');
        expect(cropPickerValueFor(null)).toBe('');
        expect(cropPickerValueFor('')).toBe('');
    });

    it('the guard discriminates — a crop nobody picks is not a picker value', () => {
        // A positive control for `isCropPickerValue`: a membership test that
        // returned true for everything would satisfy nothing above.
        expect(isCropPickerValue('Wheat')).toBe(true);
        expect(isCropPickerValue('Lavender')).toBe(false);
        expect(isCropPickerValue(null)).toBe(false);
    });

    describe.each(['en', 'bg'])('labels in %s', (locale) => {
        it.each(CROP_PICKER_VALUES)('%s has a label', (crop) => {
            // `i18n-diff --check` cannot catch this: the key would be missing
            // from BOTH locales, which is parity.
            const m = messages(locale) as { journalEnums?: { crop?: Record<string, string> } };
            expect(m.journalEnums?.crop?.[crop]).toBeTruthy();
        });
    });
});
