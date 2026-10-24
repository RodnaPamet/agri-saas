/**
 * The correction disclosure on the printed ДНЕВНИК — #2172.
 *
 * Owner decision 2026-10-24: a corrected treatment prints its CORRECTED values
 * plus a «Забележка» note. So the table says what is true now, and the note
 * discloses that it was not always what it says — the half a regulator cannot
 * otherwise see, because the previous values live in the `TreatmentCorrection`
 * trail rather than on the form.
 *
 * What is asserted is mostly about the MARKER, because the form constrains it
 * harder than it looks:
 *
 *   1. The 12-column «ПРОВЕДЕНИ ХИМИЧНИ ОБРАБОТКИ» table is fixed by заповед
 *      РД 11-3194/31.12.2021. There is no «Забележка» column to put this in —
 *      the one that exists belongs to the sample/analysis table — so the note
 *      is a footnote and the row carries a marker.
 *   2. The marker is NOT an asterisk. Column 11 of this very table carries the
 *      form's own `*` (the чл. 84 ал. 1 note on the person), so an asterisk in
 *      a cell would be read as that one. Asserted here against the real label,
 *      so the reason survives a reading of the form.
 *   3. It goes on the DATE, because the whole ROW was corrected rather than one
 *      of its values — the same reasoning the derived-observation marker
 *      records — and no other cell moves.
 *   4. An unmarked row stays byte-identical, including when `corrected` is
 *      absent rather than false: every row written before the trail existed has
 *      no correction on record, and that is true rather than unknown.
 */
import {
    buildChemicalRows,
    buildFertilizerRows,
    BG_LABELS,
    type SprayLineData,
    type FertilizeLineData,
} from '@/app-layer/reports/pdf/farm-record-diary';

const spray = (over: Partial<SprayLineData> = {}): SprayLineData => ({
    parcelId: 'parcel-1',
    completedAt: new Date('2026-05-10T08:00:00Z'),
    targetNote: 'Житна пиявица',
    productName: 'Карате Зеон',
    dose: '0.15 л/дка',
    areaHa: 3.5,
    treatedAreaHa: null,
    phenophase: null,
    applicationTechnique: 'Наземна пръскачка',
    quarantineDays: 30,
    operatorCertNo: 'APP-123',
    agronomistName: 'Мария Иванова',
    agronomistCertNo: 'AGR-456',
    ...over,
});

const fert = (over: Partial<FertilizeLineData> = {}): FertilizeLineData => ({
    completedAt: new Date('2026-05-10T08:00:00Z'),
    productName: 'Амониев нитрат',
    activeIngredient: 'N 34%',
    dose: '20 кг/дка',
    areaHa: 3.5,
    treatedAreaHa: null,
    ...over,
});

const DATE_CELL = 1;

describe('the correction marker on a treatment row', () => {
    it('marks the DATE cell of a corrected line, and nothing else', () => {
        const plain = buildChemicalRows([spray()])[0];
        const marked = buildChemicalRows([spray({ corrected: true })])[0];

        expect(plain[DATE_CELL]).toBe('10.05.2026');
        expect(marked[DATE_CELL]).toBe('10.05.2026 (к)');

        // Every OTHER cell is untouched. Without this the test would pass on a
        // marker that also rewrote the dose or the area — the cells a regulator
        // actually reads for compliance.
        expect(marked.filter((_, i) => i !== DATE_CELL)).toEqual(
            plain.filter((_, i) => i !== DATE_CELL),
        );
        expect(marked).toHaveLength(12);
    });

    it('is NOT an asterisk, because column 11 already carries the form\'s own', () => {
        // The reason, asserted rather than written down: an asterisk in a cell
        // of this table would be read as the чл. 84 ал. 1 note in its header.
        expect(BG_LABELS.chemCols[10]).toContain('*');
        const marked = buildChemicalRows([spray({ corrected: true })])[0];
        expect(marked[DATE_CELL]).not.toContain('*');
    });

    it('leaves a row with NO correction on record unmarked', () => {
        // `undefined`, not `false`. Every line written before the trail existed
        // reaches this with the field absent, and "no correction on record" is
        // true for them rather than unknown.
        const absent = buildChemicalRows([spray()])[0];
        const explicit = buildChemicalRows([spray({ corrected: false })])[0];
        expect(absent[DATE_CELL]).toBe('10.05.2026');
        expect(explicit[DATE_CELL]).toBe('10.05.2026');
    });

    it('marks only the corrected lines when a table mixes them', () => {
        // The register is filed per field and a sheet can carry both, so a
        // document-wide marker would overstate which rows moved.
        const rows = buildChemicalRows([
            spray(),
            spray({ corrected: true }),
            spray({ corrected: false }),
        ]);
        expect(rows.map((r) => r[DATE_CELL])).toEqual([
            '10.05.2026',
            '10.05.2026 (к)',
            '10.05.2026',
        ]);
        // And the «Пореден №» still runs 1..n — the marker is not a row.
        expect(rows.map((r) => r[0])).toEqual(['1', '2', '3']);
    });

    it('marks торене rows on the same terms', () => {
        const plain = buildFertilizerRows([fert()])[0];
        const marked = buildFertilizerRows([fert({ corrected: true })])[0];
        expect(plain[DATE_CELL]).toBe('10.05.2026');
        expect(marked[DATE_CELL]).toBe('10.05.2026 (к)');
        expect(marked.filter((_, i) => i !== DATE_CELL)).toEqual(
            plain.filter((_, i) => i !== DATE_CELL),
        );
    });
});

describe('the «Забележка» caption', () => {
    it('explains the marker it is the legend for', () => {
        // A marker whose legend does not name it is a marker nobody can read.
        expect(BG_LABELS.correctedNote).toContain('(к)');
        expect(BG_LABELS.correctedNote).toContain('Забележка');
    });

    it('says the printed values are the CURRENT ones', () => {
        // The owner's decision was corrected values PLUS a note, not a note
        // instead of them. A caption that left that ambiguous would invite a
        // regulator to read the row as the original entry.
        expect(BG_LABELS.correctedNote).toMatch(/коригирани/);
        expect(BG_LABELS.correctedNote).toMatch(/актуалните/);
    });

    it('is Bulgarian, like every other label on this form', () => {
        // `DiaryLabels` has one implementation on purpose — this is a Bulgarian
        // regulatory form, not localised copy. Latin text here would print as
        // English on a БАБХ document.
        expect(BG_LABELS.correctedNote).toMatch(/[А-Яа-я]/);
        expect(BG_LABELS.correctedNote.replace(/[^A-Za-z]/g, '')).toBe('');
    });
});
