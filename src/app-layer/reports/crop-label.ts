/**
 * Bulgarian crop labels for the printed registers.
 *
 * ## The defect this closes
 *
 * `Parcel.cropType` stores a CATALOGUE KEY — `'Wheat'`, `'Sunflower'` — and
 * every client translates it only for display. The web does this through
 * `cropLabel()` in `@/lib/agriculture/crop-options`, against the `crops`
 * namespace. The PDF writers printed the key raw, so «ДНЕВНИК НА
 * РАСТИТЕЛНАТА ЗАЩИТА» and «Дневник на стопанството» rendered «Wheat» in the
 * crop column of a Bulgarian regulatory form.
 *
 * ## One catalogue, not a second copy
 *
 * This resolves against the SAME `crops` namespace the UI uses rather than
 * carrying its own table. A second copy of seven crop names would drift from
 * the first, and the whole i18n discipline in this repo is one catalogue per
 * string. Nothing new was added to `messages/` for this — the keys were
 * already there, which is why the web has been correct all along.
 *
 * ## Always Bulgarian, never the requester's locale
 *
 * `farm-record-diary.ts` states it at the top of the file: *the document
 * language is Bulgarian regardless of UI locale*, and every column header in
 * it is a hardcoded Bulgarian literal. These are forms submitted to a
 * Bulgarian authority, so a crop name must not follow whoever pressed the
 * button. That is why this takes no locale parameter — a caller cannot pass
 * the wrong one.
 *
 * ## An off-catalogue value prints VERBATIM
 *
 * `cropLabel()`'s rule, kept deliberately: *an imported `cropType` that isn't
 * one of the six has no key, so it renders verbatim — never hidden*. A farm
 * that imported a shapefile with «Люцерна» in the crop column must see
 * «Люцерна» on its register, not a blank cell and not a key.
 *
 * ## What this must NOT be used for
 *
 * `CropPlan.cropType.name` is a FARM-AUTHORED name on a tenant's own
 * `CropType` row, not a catalogue key. It is already whatever the farm typed,
 * so it prints as written. `farm-record-diary.ts` prefers it over
 * `Parcel.cropType` and only the fallback branch goes through here;
 * «Предшественик» comes exclusively from that relation and therefore needs no
 * resolution at all.
 */
import { CROP_VALUES } from '@/lib/agriculture/crop-options';
import { translateFor } from '@/lib/i18n/server-messages';
import type { Locale } from '@/lib/i18n/locales';

/** Not a parameter. See "Always Bulgarian" above. */
const DOCUMENT_LOCALE: Locale = 'bg';

/**
 * Catalogue key → Bulgarian label, loaded once per document.
 *
 * Bounded by `CROP_VALUES` (seven today), so this is seven cache-warm lookups
 * rather than one per parcel — a register covering a hundred parcels resolves
 * the same seven strings.
 *
 * A key with no catalogue entry is OMITTED rather than mapped to itself, so
 * `cropLabelForDocument` can tell "off-catalogue" from "translated" and the
 * verbatim rule stays in one place.
 */
export async function loadDocumentCropLabels(): Promise<ReadonlyMap<string, string>> {
    const labels = new Map<string, string>();
    for (const value of CROP_VALUES) {
        const key = `crops.${value}`;
        const label = await translateFor(DOCUMENT_LOCALE, key);
        // `translateFor` returns the KEY when it finds nothing, which would
        // put `crops.Wheat` in the crop column — worse than the English it
        // replaces. Treat that as absent.
        if (label !== key) labels.set(value, label);
    }
    return labels;
}

/**
 * The label to print for a stored `Parcel.cropType`.
 *
 * `null`/empty in ⇒ `null` out, because the callers' field is nullable and the
 * builders already render `?? ''` for an absent crop.
 */
export function cropLabelForDocument(
    labels: ReadonlyMap<string, string>,
    storedValue: string | null | undefined,
): string | null {
    if (!storedValue) return null;
    return labels.get(storedValue) ?? storedValue;
}
