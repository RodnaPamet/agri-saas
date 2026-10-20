/**
 * The structural half of `parcels[]` — #2072 part B.
 *
 * The AREA bound (0 < treatedAreaHa <= the parcel's own area) lives in the
 * usecase, because only it holds the parcel row. These two checks need nothing
 * but the request, so they belong in the schema, where the refusal can name
 * the offending INDEX instead of just the request.
 *
 * Both of them exist because the alternative is silent and wrong on a
 * regulated document:
 *
 *   - An id not in `parcelIds` would be DROPPED, and the register would print
 *     the whole parcel instead — a larger number than the farmer typed.
 *   - Two areas for one parcel has no defined meaning, and whichever won would
 *     be an arbitrary choice over a number that reaches БАБХ.
 */
import { RecordDiaryTreatmentSchema } from '@/lib/schemas';

const base = {
    kind: 'SPRAY' as const,
    occurredOn: '2026-03-04',
    parcelIds: ['p1', 'p2'],
    productItemId: 'item-1',
    doseValue: 2,
    doseUnitId: 'u1',
};

describe('RecordDiaryTreatment.parcels', () => {
    it('accepts a subset of parcelIds', () => {
        const r = RecordDiaryTreatmentSchema.safeParse({
            ...base,
            parcels: [{ parcelId: 'p1', treatedAreaHa: 1.5 }],
        });
        expect(r.success).toBe(true);
    });

    it('accepts the field being absent entirely — it is a refinement', () => {
        expect(RecordDiaryTreatmentSchema.safeParse(base).success).toBe(true);
    });

    it('refuses a parcelId that is not in parcelIds, naming its index', () => {
        const r = RecordDiaryTreatmentSchema.safeParse({
            ...base,
            parcels: [
                { parcelId: 'p1', treatedAreaHa: 1 },
                { parcelId: 'p9', treatedAreaHa: 1 },
            ],
        });
        expect(r.success).toBe(false);
        if (r.success) return;
        // The INDEX, so a client can point at the row the user typed rather
        // than rejecting the whole form with no indication where.
        expect(r.error.issues.some((i) => i.path.join('.') === 'parcels.1.parcelId')).toBe(true);
    });

    it('refuses the same parcel twice', () => {
        const r = RecordDiaryTreatmentSchema.safeParse({
            ...base,
            parcels: [
                { parcelId: 'p1', treatedAreaHa: 1 },
                { parcelId: 'p1', treatedAreaHa: 2 },
            ],
        });
        expect(r.success).toBe(false);
        if (r.success) return;
        expect(r.error.issues.some((i) => i.path.join('.') === 'parcels.1.parcelId')).toBe(true);
    });

    it('refuses a zero or negative area without needing the parcel row', () => {
        for (const treatedAreaHa of [0, -1]) {
            const r = RecordDiaryTreatmentSchema.safeParse({
                ...base,
                parcels: [{ parcelId: 'p1', treatedAreaHa }],
            });
            expect(r.success).toBe(false);
        }
    });
});
