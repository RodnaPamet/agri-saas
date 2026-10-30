/**
 * Executing tests for the printed registers' crop labels.
 *
 * `Parcel.cropType` stores a catalogue KEY, and the PDF writers printed it
 * raw — so «ДНЕВНИК НА РАСТИТЕЛНАТА ЗАЩИТА» showed «Wheat» in the crop column
 * of a Bulgarian regulatory form. These execute the resolver rather than
 * asserting about it, because the properties at stake are behavioural: which
 * catalogue it reads, what it does with a value it does not recognise, and
 * that it cannot be made to follow the requester's language.
 */
import {
    cropLabelForDocument,
    loadDocumentCropLabels,
} from '@/app-layer/reports/crop-label';
import { CROP_VALUES } from '@/lib/agriculture/crop-options';

describe('loadDocumentCropLabels', () => {
    it('resolves every catalogue crop to Bulgarian', async () => {
        const labels = await loadDocumentCropLabels();
        // Not a spot check: the whole catalogue, so a crop added to
        // CROP_OPTIONS without a `crops.*` entry fails here rather than
        // printing its English key onto a regulatory form.
        for (const value of CROP_VALUES) {
            expect(labels.get(value)).toBeDefined();
            expect(labels.get(value)).not.toBe(value);
        }
        expect(labels.size).toBe(CROP_VALUES.size);
    });

    it('reads the same catalogue the web UI reads', async () => {
        const labels = await loadDocumentCropLabels();
        // These are the `crops` namespace values `cropLabel()` serves to the
        // parcel page. Pinned so a second, drifting copy of the crop names
        // cannot be introduced here without failing.
        expect(labels.get('Wheat')).toBe('Пшеница');
        expect(labels.get('Barley')).toBe('Ечемик');
        expect(labels.get('Canola')).toBe('Рапица');
        expect(labels.get('Maize')).toBe('Царевица');
        expect(labels.get('Sunflower')).toBe('Слънчоглед');
        expect(labels.get('Peas')).toBe('Грах');
        // Not «Трева» — the catalogue calls a perennial stand «Тревна площ»,
        // which is why this reads the catalogue instead of guessing.
        expect(labels.get('Grass')).toBe('Тревна площ');
    });

    it('omits a key with no catalogue entry rather than mapping it to itself', async () => {
        const labels = await loadDocumentCropLabels();
        expect(labels.has('Люцерна')).toBe(false);
        expect(labels.has('crops.Wheat')).toBe(false);
    });
});

describe('cropLabelForDocument', () => {
    it('translates a catalogue key', async () => {
        const labels = await loadDocumentCropLabels();
        expect(cropLabelForDocument(labels, 'Sunflower')).toBe('Слънчоглед');
    });

    it('prints an off-catalogue value VERBATIM, never blank and never a key', async () => {
        const labels = await loadDocumentCropLabels();
        // A farm that imported a shapefile with its own crop name must see
        // that name on its register. `cropLabel()`'s rule, kept deliberately:
        // never hidden.
        expect(cropLabelForDocument(labels, 'Люцерна')).toBe('Люцерна');
        expect(cropLabelForDocument(labels, 'Triticale')).toBe('Triticale');
    });

    it.each([null, undefined, ''])('maps %p to null for the builders', async (value) => {
        const labels = await loadDocumentCropLabels();
        expect(cropLabelForDocument(labels, value)).toBeNull();
    });

    it('takes no locale, so a caller cannot print an English register', async () => {
        // The document language is Bulgarian regardless of UI locale —
        // `farm-record-diary.ts` says so at the top of the file and every
        // column header in it is a hardcoded Bulgarian literal. A `locale`
        // parameter here would be a way to get that wrong, so there isn't one.
        expect(loadDocumentCropLabels).toHaveLength(0);
        expect(cropLabelForDocument).toHaveLength(2);
    });
});
