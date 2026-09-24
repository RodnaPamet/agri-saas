/**
 * Every crop the picker offers has a Bulgarian name.
 *
 * `Grass` was live on a production parcel while absent from `CROP_OPTIONS`, so
 * it rendered as the English word on a Bulgarian screen — on the web and, once
 * the native client adopted the same mapping, there too. `cropLabel` falls
 * back to the raw stored value for anything it has no key for, which is the
 * RIGHT behaviour (never hide what a farmer recorded) and is precisely what
 * made the gap visible rather than blank.
 *
 * The gap was not that the fallback fired. It was that nothing said the
 * catalogue and the translations had drifted apart. Adding a crop to the
 * picker and forgetting its label is a one-line mistake with no other symptom,
 * so this is the test that has to catch it.
 *
 * It cannot see PRODUCTION values — `cropType` is free text, so a farm may
 * hold a crop nobody has catalogued and that is allowed. What it can pin is
 * that everything the product OFFERS, the product can also NAME.
 */
import en from '@/../messages/en.json';
import bg from '@/../messages/bg.json';
import { CROP_OPTIONS, CROP_VALUES, cropLabel, cropSeasonLabel } from '@/lib/agriculture/crop-options';

const enCrops = en.crops as Record<string, string>;
const bgCrops = bg.crops as Record<string, string>;

/** A translator over a plain record, matching the `CropTranslator` shape. */
function translator(dict: Record<string, string>) {
    const t = ((key: string) => dict[key] ?? key) as ((key: string) => string) & {
        has(key: string): boolean;
    };
    t.has = (key: string) => Object.prototype.hasOwnProperty.call(dict, key);
    return t;
}

describe('the crop catalogue and its translations agree', () => {
    it('finds the catalogue (positive control)', () => {
        // An empty catalogue satisfies every "for each" below.
        expect(CROP_OPTIONS.length).toBeGreaterThan(5);
        expect(CROP_VALUES.size).toBe(CROP_OPTIONS.length);
    });

    it.each(CROP_OPTIONS.map((o) => o.value))('%s has a label in BOTH locales', (value) => {
        expect(enCrops[value]).toBeTruthy();
        expect(bgCrops[value]).toBeTruthy();
    });

    it.each([...new Set(CROP_OPTIONS.map((o) => o.meta?.season).filter(Boolean))])(
        'the season group %s resolves to a translated caption',
        (season) => {
            // A new group added without its key would otherwise render the raw
            // English grouping string to a Bulgarian farmer.
            const label = cropSeasonLabel(translator(bgCrops), season as string);
            expect(label).toBeTruthy();
            expect(label).not.toBe(season);
        },
    );

    it('every Bulgarian crop name is actually in Cyrillic', () => {
        // The failure this guards is a label added in English to bg.json,
        // which parity checks cannot see — the key exists in both files.
        for (const { value } of CROP_OPTIONS) {
            expect(bgCrops[value]).toMatch(/[Ѐ-ӿ]/);
        }
    });

    it('an off-catalogue value renders verbatim rather than blank', () => {
        // The fallback that made the Grass gap visible. `cropType` is free
        // text, so this path is reachable by design and must never hide what
        // the farmer stored.
        const t = translator(bgCrops);
        expect(cropLabel(t, 'Lucerne')).toBe('Lucerne');
        expect(cropLabel(t, 'нещо на кирилица')).toBe('нещо на кирилица');
    });

    it('Grass is catalogued — it was live in production and untranslated', () => {
        // The specific regression. Named rather than left implicit, because
        // the general assertions above would pass again the moment someone
        // removed it.
        expect(CROP_VALUES.has('Grass')).toBe(true);
        expect(bgCrops.Grass).toBe('Тревна площ');
    });
});
