/**
 * The pest and disease thresholds dataset (agrent-ios#636).
 */
import raw from '@/lib/agro/thresholds/dataset.json';
import { THRESHOLDS, thresholdCrops, thresholdsFor, validateThresholds } from '@/lib/agro/thresholds/load';

const clone = () => JSON.parse(JSON.stringify(raw));

describe('the committed dataset', () => {
    it('loads, with a page for every entry', () => {
        expect(THRESHOLDS.thresholds.length).toBeGreaterThanOrEqual(29);
        for (const t of THRESHOLDS.thresholds) {
            expect(Object.keys(THRESHOLDS.sources)).toContain(t.cite.source);
            expect(t.levels.length).toBeGreaterThan(0);
        }
    });

    it('filters by crop', () => {
        const wheat = thresholdsFor('wheat');
        expect(wheat.length).toBeGreaterThan(0);
        expect(wheat.every((t) => t.crops.includes('wheat'))).toBe(true);
        expect(wheat.map((t) => t.id)).toContain('powdery-mildew');
        // Control: the filter narrows rather than passing everything through.
        expect(thresholdsFor('sunflower').length).toBeLessThan(THRESHOLDS.thresholds.length);
        expect(thresholdCrops()).toEqual(expect.arrayContaining(['wheat', 'barley', 'maize', 'sunflower']));
    });
});

describe('what the validator refuses', () => {
    it('a duplicate id', () => {
        const d = clone();
        d.thresholds.push({ ...d.thresholds[0] });
        expect(() => validateThresholds(d)).toThrow(/duplicate id/);
    });

    it('an unresolved citation', () => {
        const d = clone();
        d.thresholds[0].cite.source = 'nowhere';
        expect(() => validateThresholds(d)).toThrow(/sources map/);
    });

    it('an entry with no levels', () => {
        const d = clone();
        d.thresholds[0].levels = [];
        expect(() => validateThresholds(d)).toThrow(/malformed/);
    });

    it('an entry with no page', () => {
        const d = clone();
        delete d.thresholds[0].cite.page;
        expect(() => validateThresholds(d)).toThrow(/malformed/);
    });

    it('accepts the unmodified clone (control)', () => {
        expect(() => validateThresholds(clone())).not.toThrow();
    });
});
