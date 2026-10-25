/**
 * The «ДНЕВНИК НА СТОПАНСТВОТО» row builder — #2316.
 *
 * Uses the REAL `ACTIVITY_LABELS_BG`, not a fixture of it. The labels are the
 * contract between the two halves of this issue, and a test that invented its
 * own would keep passing after the real map changed — which is the only way
 * these assertions could matter and then quietly stop.
 */
import { ACTIVITY_LABELS_BG } from '@/lib/operations/activity-labels';
import {
    buildCampaignRows,
    formatDateCell,
    formatHa,
    lineAreaHa,
    type DiaryLineInput,
} from '@/app-layer/reports/campaign-diary/rows';

const AT = (iso: string) => new Date(iso);

const line = (over: Partial<DiaryLineInput> = {}): DiaryLineInput => ({
    treatmentGroupId: 'grp-1',
    taskId: 'task-1',
    operationType: 'SPRAY',
    completedAt: AT('2025-02-01T08:00:00Z'),
    parcelId: 'p1',
    parcelName: 'Нива 1',
    cropName: 'Пшеница',
    parcelAreaHa: 10,
    treatedAreaHa: 10,
    productName: 'Карате Зеон',
    doseValue: 0.15,
    doseUnitSymbol: 'л/дка',
    produceKg: null,
    produceKind: null,
    ...over,
});

describe('buildCampaignRows — one row is an ACTIVITY, not a line (#2316)', () => {
    it('sums one spraying across several parcels into ONE row', () => {
        // The headline difference from the per-block БАБХ register, where this
        // would be three rows. «Пръскане – 17,05 ха» is one activity.
        const { rows } = buildCampaignRows(
            [
                line({ parcelId: 'p1', parcelName: 'Нива 1', treatedAreaHa: 7.05 }),
                line({ parcelId: 'p2', parcelName: 'Нива 2', treatedAreaHa: 6 }),
                line({ parcelId: 'p3', parcelName: 'Нива 3', treatedAreaHa: 4 }),
            ],
            ACTIVITY_LABELS_BG,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].area).toBe('17,05');
        expect(rows[0].activity).toBe('Пръскане – 17,05 ха');
        expect(rows[0].parcelIds).toBe('Нива 1, Нива 2, Нива 3');
    });

    it('treatedAreaHa NULL means THE WHOLE PARCEL, not zero', () => {
        // The load-bearing case. Every line written before #2072 is NULL, and
        // `?? 0` would silently under-report them — looking like a data
        // problem rather than a code one. The schema documents the rule at
        // `OperationParcel.treatedAreaHa`.
        expect(lineAreaHa(line({ treatedAreaHa: null, parcelAreaHa: 12.5 }))).toBe(12.5);
        const { rows } = buildCampaignRows(
            [
                line({ parcelId: 'p1', treatedAreaHa: null, parcelAreaHa: 12.5 }),
                line({ parcelId: 'p2', treatedAreaHa: null, parcelAreaHa: 3.25 }),
            ],
            ACTIVITY_LABELS_BG,
        );
        expect(rows[0].area).toBe('15,75');
        expect(rows[0].area).not.toBe('0,00');
    });

    it('a tank mix does not count a parcel\'s area once per product', () => {
        // Several products on ONE parcel is one treated area. Summing per line
        // would report 20 ха of work on a 10 ха field.
        const { rows } = buildCampaignRows(
            [
                line({ parcelId: 'p1', treatedAreaHa: 10, productName: 'Карате Зеон' }),
                line({ parcelId: 'p1', treatedAreaHa: 10, productName: 'Фолиар' }),
            ],
            ACTIVITY_LABELS_BG,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].area).toBe('10,00');
        expect(rows[0].productName).toBe('Карате Зеон, Фолиар');
    });

    it('two separate prunings on the SAME DAY are two rows', () => {
        // Why the key is `treatmentGroupId` and not `(date, operationType)`:
        // inferring the activity from the pair would merge these, understating
        // the work and misstating the area.
        const { rows } = buildCampaignRows(
            [
                line({ treatmentGroupId: 'grp-a', operationType: 'PRUNE', parcelId: 'p1', treatedAreaHa: 4, productName: null, doseValue: null, doseUnitSymbol: null }),
                line({ treatmentGroupId: 'grp-b', operationType: 'PRUNE', parcelId: 'p2', treatedAreaHa: 6, productName: null, doseValue: null, doseUnitSymbol: null }),
            ],
            ACTIVITY_LABELS_BG,
        );
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.area).sort()).toEqual(['4,00', '6,00']);
        expect(rows[0].activity).toBe('Резитба – 4,00 ха');
    });

    it('historical lines with NO group do not collapse into one row', () => {
        // Grouping them all under `null` would make every pre-group activity
        // of a whole campaign a single row with a nonsense total. One task is
        // its own group.
        const { rows } = buildCampaignRows(
            [
                line({ treatmentGroupId: null, taskId: 't1', parcelId: 'p1', treatedAreaHa: 5 }),
                line({ treatmentGroupId: null, taskId: 't2', parcelId: 'p2', treatedAreaHa: 8 }),
            ],
            ACTIVITY_LABELS_BG,
        );
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.area)).toEqual(['5,00', '8,00']);
    });

    it('drops lines with no completion, and COUNTS them', () => {
        // The register records work that was done. Reported rather than
        // silently dropped: an unexplained difference between what the app
        // shows and what the document prints is undebuggable.
        const { rows, skippedIncomplete } = buildCampaignRows(
            [
                line({ parcelId: 'p1', treatedAreaHa: 5 }),
                line({ treatmentGroupId: 'grp-2', completedAt: null, parcelId: 'p2' }),
            ],
            ACTIVITY_LABELS_BG,
        );
        expect(rows).toHaveLength(1);
        expect(skippedIncomplete).toBe(1);
    });

    it('«Продукция» is EMPTY, never "0,00", when nothing was recorded', () => {
        // A zero asserts the harvest produced nothing; an empty cell says
        // nobody wrote it down. In a register those are different claims, and
        // the owner's photographed form shows the column empty.
        const { rows } = buildCampaignRows(
            [line({ operationType: 'HARVEST', produceKg: null, productName: null, doseValue: null, doseUnitSymbol: null })],
            ACTIVITY_LABELS_BG,
        );
        expect(rows[0].produceKg).toBe('');
        expect(rows[0].produceKind).toBe('');
        expect(rows[0].activity).toBe('Прибиране на реколтата – 10,00 ха');
    });

    it('sums «Продукция» across the activity when it IS recorded', () => {
        const { rows } = buildCampaignRows(
            [
                line({ operationType: 'HARVEST', parcelId: 'p1', produceKg: 4200, produceKind: 'Пшеница' }),
                line({ operationType: 'HARVEST', parcelId: 'p2', produceKg: 3800, produceKind: 'Пшеница' }),
            ],
            ACTIVITY_LABELS_BG,
        );
        expect(rows[0].produceKg).toBe('8000,00');
        expect(rows[0].produceKind).toBe('Пшеница');
    });

    it('uses CULTIVATE\'s full label, which must not read as a spraying', () => {
        // «Обработка» alone already means a CHEMICAL treatment in the БАБХ
        // register — its own table is «химични обработки» — so a row reading
        // «Обработка – 17,05 ха» in a document that also lists sprayings reads
        // as a spraying to the farmer it is written for.
        const { rows } = buildCampaignRows(
            [line({ operationType: 'CULTIVATE', productName: null, doseValue: null, doseUnitSymbol: null })],
            ACTIVITY_LABELS_BG,
        );
        expect(rows[0].activity).toBe('Обработка на почвата – 10,00 ха');
        expect(rows[0].activity).not.toMatch(/^Обработка – /);
    });

    it('orders rows by first completion', () => {
        const { rows } = buildCampaignRows(
            [
                line({ treatmentGroupId: 'late', completedAt: AT('2025-05-01T08:00:00Z'), parcelName: 'Б' }),
                line({ treatmentGroupId: 'early', completedAt: AT('2025-02-01T08:00:00Z'), parcelName: 'А' }),
            ],
            ACTIVITY_LABELS_BG,
        );
        expect(rows.map((r) => r.date)).toEqual(['01.02.2025', '01.05.2025']);
    });

    it('ranges over a real set — an empty input yields no rows and no crash', () => {
        const { rows, skippedIncomplete } = buildCampaignRows([], ACTIVITY_LABELS_BG);
        expect(rows).toEqual([]);
        expect(skippedIncomplete).toBe(0);
    });
});

describe('formatDateCell', () => {
    it('collapses a same-month range the way the template shows', () => {
        expect(formatDateCell(AT('2025-02-01T06:00:00Z'), AT('2025-02-05T18:00:00Z')))
            .toBe('01-05.02.2025');
    });

    it('prints a single day when the work was one day', () => {
        expect(formatDateCell(AT('2025-02-01T06:00:00Z'), AT('2025-02-01T18:00:00Z')))
            .toBe('01.02.2025');
    });

    it('spells BOTH ends across a month boundary', () => {
        // `28-03.03.2025` would read as a single impossible date.
        expect(formatDateCell(AT('2025-02-28T06:00:00Z'), AT('2025-03-03T18:00:00Z')))
            .toBe('28.02.2025-03.03.2025');
    });

    it('spells both ends across a year boundary', () => {
        expect(formatDateCell(AT('2024-12-30T06:00:00Z'), AT('2025-01-02T18:00:00Z')))
            .toBe('30.12.2024-02.01.2025');
    });
});

describe('formatHa — the form is in ХЕКТАРИ', () => {
    it('is two decimals with a comma, never a dot and never дка', () => {
        // The БАБХ register converts to дка for display; this document does
        // not, and `toDka` is deliberately not imported here.
        expect(formatHa(17.05)).toBe('17,05');
        expect(formatHa(10)).toBe('10,00');
        expect(formatHa(0.5)).toBe('0,50');
        expect(formatHa(17.05)).not.toContain('.');
    });
});
