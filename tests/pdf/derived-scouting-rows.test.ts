/**
 * Scouting rows derived from treatments — #1740 Q2, #2072 part A.
 *
 * The owner's ruling was "derive the observation table from the treatments,
 * like PRZ". That derivation had never been built: `buildObservationRows` only
 * ever received OBSERVATION journal entries, and a treatment-scoped document
 * carried none at all, so «Фенофаза/BBCH» — the column the phenophase was
 * recorded FOR — was always empty.
 *
 * What is asserted here is mostly what the derivation REFUSES to do, because
 * this document is read by a regulator and the expensive mistakes are all
 * over-claims:
 *
 *   1. A row is derived only when the treatment recorded a phenophase. A date
 *      with nothing beside it would assert an inspection that found nothing.
 *   2. «Болест» and «Неприятел» stay blank. A treatment's single «Вредител»
 *      note cannot be split between two columns without guessing, and
 *      "applied against X" is not "X was observed at this density".
 *   3. The measurement columns stay blank. Nobody surveyed an area.
 *   4. A derived row is MARKED, and a recorded one is not.
 *   5. The caption says, in Bulgarian, that marked rows are not an inspection.
 */
import {
    deriveObservationsFromSprays,
    buildObservationRows,
    BG_LABELS,
    type SprayLineData,
    type ObservationData,
} from '@/app-layer/reports/pdf/farm-record-diary';

const line = (over: Partial<SprayLineData> = {}): SprayLineData => ({
    parcelId: 'parcel-1',
    completedAt: new Date('2026-05-10T08:00:00Z'),
    targetNote: 'Житна пиявица',
    productName: 'Карате Зеон',
    dose: '0.15 л/дка',
    areaHa: 3.5,
    treatedAreaHa: null,
    phenophase: 'Начало на цъфтеж (BBCH 61)',
    applicationTechnique: 'Наземна пръскачка',
    quarantineDays: 30,
    operatorCertNo: 'APP-123',
    agronomistName: 'Мария Иванова',
    agronomistCertNo: 'AGR-456',
    ...over,
});

describe('deriveObservationsFromSprays', () => {
    it('derives one row per line that recorded a phenophase', () => {
        const out = deriveObservationsFromSprays([line(), line({ phenophase: 'BBCH 32' })]);
        expect(out).toHaveLength(2);
        expect(out.map((o) => o.phenophase)).toEqual(['Начало на цъфтеж (BBCH 61)', 'BBCH 32']);
        expect(out.every((o) => o.derived)).toBe(true);
    });

    it('derives NOTHING for a line with no phenophase', () => {
        // Both the null and the empty-string cases: a trimmed-to-empty value
        // from a client is "not captured", not "an inspection found nothing".
        expect(deriveObservationsFromSprays([line({ phenophase: null })])).toEqual([]);
        expect(deriveObservationsFromSprays([line({ phenophase: '' })])).toEqual([]);
    });

    it('carries the treatment date, so the section stays a chronology', () => {
        const [out] = deriveObservationsFromSprays([
            line({ completedAt: new Date('2026-04-02T06:00:00Z') }),
        ]);
        expect(out.occurredAt).toEqual(new Date('2026-04-02T06:00:00Z'));
    });

    it('leaves «Болест» and «Неприятел» null even though the line names a target', () => {
        const [out] = deriveObservationsFromSprays([line({ targetNote: 'Брашнеста мана' })]);
        // `targetNote` is the form's «Вредител» — ONE field. The scouting
        // table has two columns and nothing says which this belongs in.
        expect(out.disease).toBeNull();
        expect(out.pest).toBeNull();
    });
});

describe('a derived row prints as derived', () => {
    const derived = deriveObservationsFromSprays([line()]);
    const recorded: ObservationData = {
        occurredAt: new Date('2026-05-01T08:00:00Z'),
        phenophase: 'BBCH 32',
        disease: 'Брашнеста мана',
        pest: 'Листни въшки',
        derived: false,
    };

    it('marks the derived row and leaves the recorded one unmarked', () => {
        const [d] = buildObservationRows(derived);
        const [r] = buildObservationRows([recorded]);
        expect(d[0]).toBe('10.05.2026 *');
        // The discriminator: without this, a test asserting only the asterisk
        // would pass against a builder that marked EVERY row.
        expect(r[0]).toBe('01.05.2026');
        expect(r[0]).not.toContain('*');
    });

    it('fills only the date and the growth stage — every other cell is blank', () => {
        const [d] = buildObservationRows(derived);
        expect(d).toHaveLength(BG_LABELS.obsCols.length);
        expect(d[1]).toBe('Начало на цъфтеж (BBCH 61)');
        // Columns 3-11 (indices 2..10): болест, обследвана/нападната площ,
        // степен, неприятел, and the rest. None of these is something a
        // spraying knows, and inventing them would be survey data the
        // register would present as measured.
        expect(d.slice(2).every((c) => c === '')).toBe(true);
    });

    it('states in Bulgarian that a marked row is not an inspection', () => {
        const note = BG_LABELS.derivedNote;
        expect(note.startsWith('*')).toBe(true);
        // The three things the sentence has to carry, so a reword cannot
        // quietly drop the disclosure while leaving a caption behind.
        expect(note).toContain('изведени');            // derived
        expect(note).toContain('химични обработки');   // from the treatments
        expect(note).toContain('обследване');          // not a scouting
    });
});
