/**
 * Shared weed catalogue for the ag UI — the vocabulary a farmer picks from
 * when recording which weeds were identified in a parcel.
 *
 * Modelled on `crop-options.ts`, which is the repo's established shape for a
 * picked-and-persisted agronomic vocabulary: a stable `value` that goes in the
 * database, a `label` for display, and `meta` for grouping in the combobox.
 *
 * ## Why the stored value is the Latin binomial
 *
 * Crops store an English name (`Parcel.cropType = 'Wheat'`) because the crop
 * list is short, universally known, and already in the data. Weeds are
 * neither: common names vary by region and several species share one in
 * Bulgarian. The binomial is the identifier agronomists actually use, it is
 * stable across languages, and it is what makes "which parcels had Sorghum
 * halepense over five years" answerable at all. The farmer never sees it —
 * `weedLabel` resolves the Bulgarian common name through the `weeds`
 * namespace.
 *
 * ## Why there is a free-text escape beside this list
 *
 * `ParcelWeedObservation` carries `otherWeeds` alongside `weedKeys`. A
 * controlled list that cannot express what someone actually found does not
 * produce clean data — it produces an abandoned feature, and the observation
 * goes unrecorded. The two columns stay separate so the controlled half
 * remains reportable; see the model docblock.
 *
 * `ComboboxOption` is imported type-only (erased at build) — no runtime
 * dependency on the UI layer, matching `crop-options.ts`.
 */
import type { ComboboxOption } from '@/components/ui/combobox';

/**
 * Common arable weeds of Bulgarian field crops.
 *
 * Grouped grass/broadleaf because that is the division that decides the
 * herbicide, so it is the grouping a farmer scans the list by. Not exhaustive
 * and not meant to be — `otherWeeds` carries the rest.
 */
export const WEED_OPTIONS: ComboboxOption<{ group: string }>[] = [
    // ── Grasses ──
    { value: 'Sorghum halepense', label: 'Sorghum halepense', meta: { group: 'Grass weed' } },
    { value: 'Echinochloa crus-galli', label: 'Echinochloa crus-galli', meta: { group: 'Grass weed' } },
    { value: 'Setaria viridis', label: 'Setaria viridis', meta: { group: 'Grass weed' } },
    { value: 'Avena fatua', label: 'Avena fatua', meta: { group: 'Grass weed' } },
    { value: 'Cynodon dactylon', label: 'Cynodon dactylon', meta: { group: 'Grass weed' }, separatorAfter: true },
    // ── Broadleaves ──
    { value: 'Cirsium arvense', label: 'Cirsium arvense', meta: { group: 'Broadleaf weed' } },
    { value: 'Convolvulus arvensis', label: 'Convolvulus arvensis', meta: { group: 'Broadleaf weed' } },
    { value: 'Chenopodium album', label: 'Chenopodium album', meta: { group: 'Broadleaf weed' } },
    { value: 'Amaranthus retroflexus', label: 'Amaranthus retroflexus', meta: { group: 'Broadleaf weed' } },
    { value: 'Sinapis arvensis', label: 'Sinapis arvensis', meta: { group: 'Broadleaf weed' } },
    { value: 'Raphanus raphanistrum', label: 'Raphanus raphanistrum', meta: { group: 'Broadleaf weed' } },
    { value: 'Papaver rhoeas', label: 'Papaver rhoeas', meta: { group: 'Broadleaf weed' } },
    { value: 'Galium aparine', label: 'Galium aparine', meta: { group: 'Broadleaf weed' } },
];

/** The set of catalogue weed values, for validating a submitted key. */
export const WEED_VALUES: ReadonlySet<string> = new Set(WEED_OPTIONS.map((o) => o.value));

/**
 * A next-intl translator scoped to the `weeds` namespace. Structural, not
 * importing next-intl's own types, so this catalogue stays free of any
 * runtime/UI dependency — identical to `CropTranslator`.
 */
export interface WeedTranslator {
    (key: string): string;
    has(key: string): boolean;
}

/** Map a `meta.group` catalogue string to its `weeds`-namespace key. */
const GROUP_KEY: Record<string, string> = {
    'Grass weed': 'groupGrass',
    'Broadleaf weed': 'groupBroadleaf',
};

/**
 * Localised common name for a weed VALUE via the `weeds` namespace.
 *
 * A value with no key renders verbatim rather than blank — which is what keeps
 * a free-text entry from `otherWeeds` displayable through the same helper as a
 * catalogue one. Same rule as `cropLabel`, and for the same reason: never hide
 * something the farmer recorded.
 */
export function weedLabel(t: WeedTranslator, value: string): string {
    return t.has(value) ? t(value) : value;
}

/** Localised group caption for a `meta.group` catalogue string. */
export function weedGroupLabel(t: WeedTranslator, group: string | undefined): string {
    if (!group) return '';
    const key = GROUP_KEY[group];
    return key ? t(key) : group;
}

/**
 * Build the weed combobox options with localised labels + group captions,
 * preserving the persisted `value`. Every surface that renders `WEED_OPTIONS`
 * should map through this so the farmer sees Bulgarian common names while the
 * stored value stays the binomial.
 */
export function localizedWeedOptions(t: WeedTranslator): ComboboxOption<{ group: string }>[] {
    return WEED_OPTIONS.map((o) => ({
        ...o,
        label: weedLabel(t, o.value),
        meta: { group: weedGroupLabel(t, o.meta?.group) },
    }));
}
