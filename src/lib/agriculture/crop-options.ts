/**
 * Shared crop catalogue for the ag UI — the single source of truth for the
 * crop picker used on the Location parcels dropdown, the shapefile-import
 * crop step (#7), the map crop-icon table (#1), and crop planning (#9).
 *
 * Extracted from the previously page-local `CROP_OPTIONS` so every surface
 * that lets a user pick a parcel crop shares one list (and one season
 * grouping). `value` is what we persist to `Parcel.cropType`; `label` is the
 * display string; `meta.season` groups the options in the combobox.
 *
 * `ComboboxOption` is imported type-only (erased at build) — no runtime
 * dependency on the UI layer.
 */
import type { ComboboxOption } from '@/components/ui/combobox';

export const CROP_OPTIONS: ComboboxOption<{ season: string }>[] = [
    { value: 'Wheat', label: 'Wheat', meta: { season: 'Autumn crop' } },
    { value: 'Barley', label: 'Barley', meta: { season: 'Autumn crop' } },
    { value: 'Canola', label: 'Canola', meta: { season: 'Autumn crop' }, separatorAfter: true },
    { value: 'Maize', label: 'Maize', meta: { season: 'Spring crop' } },
    { value: 'Sunflower', label: 'Sunflower', meta: { season: 'Spring crop' } },
    { value: 'Peas', label: 'Peas', meta: { season: 'Spring crop' }, separatorAfter: true },
    // Perennial, and NOT filed under either sowing season.
    //
    // `Grass` was live on a parcel while absent from this catalogue, so it
    // rendered as English on a Bulgarian screen — `cropLabel` falls back to the
    // raw value for anything it has no key for, which is the right behaviour
    // and was showing its seam. Filing it as an autumn or spring crop to avoid
    // a third group would have put a false agronomic claim in the picker: a ley
    // is sown once and stands for years, which is exactly why a farm carries it
    // as a distinct land use rather than a rotation entry.
    { value: 'Grass', label: 'Grass', meta: { season: 'Perennial' } },
];

/** The set of catalogue crop values, for validating a submitted cropType. */
export const CROP_VALUES: ReadonlySet<string> = new Set(CROP_OPTIONS.map((o) => o.value));

/**
 * A next-intl translator scoped to the `crops` namespace. Kept structural
 * (not importing next-intl's own types) so this shared catalogue stays free of
 * any runtime/UI dependency — the result of `useTranslations('crops')`
 * (client) or `getTranslations('crops')` (server) both satisfy this shape.
 */
export interface CropTranslator {
    (key: string): string;
    has(key: string): boolean;
}

/** Map a `meta.season` catalogue string to its `crops`-namespace key. */
const SEASON_KEY: Record<string, string> = {
    'Autumn crop': 'seasonAutumn',
    'Spring crop': 'seasonSpring',
    Perennial: 'seasonPerennial',
};

/**
 * Localised display label for a crop VALUE via the `crops` namespace
 * (`crops.<value>`). An off-catalogue value (an imported `cropType` that isn't
 * one of the six) has no key, so it renders verbatim — never hidden.
 */
export function cropLabel(t: CropTranslator, value: string): string {
    return t.has(value) ? t(value) : value;
}

/**
 * Localised season caption for a `meta.season` catalogue string via the
 * `crops` namespace (`crops.seasonAutumn` / `crops.seasonSpring`). Empty in ⇒
 * empty out (synthetic off-catalogue options carry no season).
 */
export function cropSeasonLabel(t: CropTranslator, season: string | undefined): string {
    if (!season) return '';
    const key = SEASON_KEY[season];
    return key ? t(key) : season;
}

/**
 * Build the crop combobox options with localised labels + season captions,
 * preserving the persisted `value` and `separatorAfter`. Every UI surface that
 * renders `CROP_OPTIONS` should map through this (passing its
 * `useTranslations('crops')`) so the user sees Bulgarian while the stored
 * `Parcel.cropType` value is unchanged.
 */
export function localizedCropOptions(t: CropTranslator): ComboboxOption<{ season: string }>[] {
    return CROP_OPTIONS.map((o) => ({
        ...o,
        label: cropLabel(t, o.value),
        meta: { season: cropSeasonLabel(t, o.meta?.season) },
    }));
}
