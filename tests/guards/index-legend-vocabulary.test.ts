/**
 * Every vegetation-index legend caption has a translation, in both locales.
 *
 * The captions used to be English LITERALS on the index definition —
 * `lowLabel: 'Low'`, `highLabel: 'Dry'` — and both consumers rendered them
 * verbatim. So a Bulgarian operator read "Low" and "High" under the legend of
 * an otherwise translated screen, on the satellite knowledge page and on the
 * location detail map.
 *
 * `no-hardcoded-ui-strings` could not see it: that scan looks for string
 * literals in JSX, and `{idx.lowLabel}` is a property read. The literal lived
 * one module away, in `src/lib/agro/`, which the scan does not walk at all.
 * Same blind spot as the server-authored copy class.
 *
 * They are keys now (`agroEnums.indexLegend.*`), shared verbatim with the
 * native client rather than each side inventing a wording — `messages/` was
 * already carrying three separate crop vocabularies when this was written, and
 * that is the outcome being avoided.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VEGETATION_INDICES } from '@/lib/agro/vegetation-indices';

const ROOT = path.resolve(__dirname, '../..');

function legend(locale: string): Record<string, string> {
    const raw = fs.readFileSync(path.join(ROOT, `messages/${locale}.json`), 'utf8');
    return JSON.parse(raw).agroEnums?.indexLegend ?? {};
}

describe('vegetation-index legend captions are translated', () => {
    it('the index catalogue is actually readable (positive control)', () => {
        // Every assertion below iterates the catalogue, and an empty catalogue
        // satisfies all of them. Five indices ship today.
        expect(VEGETATION_INDICES.length).toBeGreaterThanOrEqual(5);
        expect(VEGETATION_INDICES.map((i) => i.id)).toContain('ndmi');
    });

    for (const locale of ['en', 'bg']) {
        it(`${locale}: every lowKey / highKey resolves`, () => {
            const table = legend(locale);
            const missing: string[] = [];
            for (const idx of VEGETATION_INDICES) {
                if (!table[idx.lowKey]) missing.push(`${idx.id}.${idx.lowKey}`);
                if (!table[idx.highKey]) missing.push(`${idx.id}.${idx.highKey}`);
            }
            expect(missing).toEqual([]);
        });
    }

    it('no orphan captions', () => {
        const used = new Set(VEGETATION_INDICES.flatMap((i) => [i.lowKey, i.highKey]));
        expect(Object.keys(legend('en')).filter((k) => !used.has(k as never))).toEqual([]);
    });

    it('bg is not en pasted across', () => {
        // NDMI is the reason this matters: its pair is Dry/Wet, not Low/High,
        // so a careless copy would leave two of the four identical and the
        // legend half-English on exactly one index.
        const en = legend('en');
        const bg = legend('bg');
        const identical = Object.keys(en).filter((k) => en[k] === bg[k]);
        expect(identical).toEqual([]);
    });
});
