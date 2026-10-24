/**
 * `marginRefusalCopyKey` — the sentence a refused margin shows (#2259).
 *
 * Two renderers read this: the per-commodity detail and the margin scale's
 * undrawable rows. Both used to branch on `refusalCode`, which describes the
 * VALUE side, so a crop with a perfectly good market price and costs in two
 * currencies read «Няма пазарна цена за реколтата на корен» — false, and it
 * sends the farmer to fix a price that is not the problem.
 *
 * Asserted against the real catalogue rather than against key names, because a
 * key that resolves to nothing renders as its own path and the mapping would
 * still look right.
 */
import { marginRefusalCopyKey } from '@/app/t/[tenantSlug]/(app)/grain/calculator/components';
import { readCatalogue } from '../../helpers/catalogue';

const calc = (readCatalogue('bg') as Record<string, Record<string, Record<string, string>>>)
    .grain.calculator;

describe('each refusal reason gets its OWN sentence', () => {
    it.each([
        ['COST_CURRENCY_MIXED', 'marginPerDcaMixedCurrency'],
        ['COST_CURRENCY_UNRECORDED', 'marginPerDcaCurrencyUnrecorded'],
        ['NO_OCCUPIED_AREA', 'marginPerDcaNoCostArea'],
        ['COST_PRICE_CURRENCY_MISMATCH', 'marginPerDcaMismatch'],
        ['NO_STANDING_CROP_AREA', 'perAreaNoArea'],
        ['NO_STANDING_CROP_VALUE', 'perAreaNoValue'],
    ])('%s → %s', (code, key) => {
        expect(marginRefusalCopyKey(code)).toBe(key);
    });

    it('every key it can return EXISTS in the catalogue', () => {
        // The failure this guards: a mapping that is structurally right and
        // names a key nobody added, which next-intl renders as the key path.
        const codes = [
            'COST_CURRENCY_MIXED',
            'COST_CURRENCY_UNRECORDED',
            'NO_OCCUPIED_AREA',
            'COST_PRICE_CURRENCY_MISMATCH',
            'NO_STANDING_CROP_AREA',
            'NO_STANDING_CROP_VALUE',
            null,
        ];
        const missing = codes
            .map((c) => marginRefusalCopyKey(c))
            .filter((k) => typeof calc[k] !== 'string');
        expect(missing).toEqual([]);
    });

    it('the COST reasons do not all collapse onto one sentence', () => {
        // The defect was every cause rendering as "no market price". A mapping
        // that sent them all to one NEW key would be the same mistake wearing
        // different copy.
        const cost = ['COST_CURRENCY_MIXED', 'COST_CURRENCY_UNRECORDED', 'NO_OCCUPIED_AREA']
            .map((c) => marginRefusalCopyKey(c));
        expect(new Set(cost).size).toBe(3);
        // And none of them is the value-side sentence.
        expect(cost).not.toContain('perAreaNoValue');
    });

    it('an unknown code falls back rather than throwing', () => {
        // A server newer than the bundle can send a code this build has never
        // heard of. An em-dash is worse than a slightly generic sentence.
        expect(marginRefusalCopyKey('SOMETHING_NEW')).toBe('perAreaNoValue');
        expect(marginRefusalCopyKey(null)).toBe('perAreaNoValue');
    });
});
