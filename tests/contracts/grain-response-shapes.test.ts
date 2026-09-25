/**
 * The published grain schemas, checked against the REAL mappers.
 *
 * `tests/guards/contract-drift.test.ts` is the cautionary sibling. Its own
 * comment concedes what it does: it asserts DTO modules export symbols, and
 * parses hand-written fixtures. A `.passthrough()` schema parsing an object
 * literal written by the same hand that wrote the schema cannot fail for the
 * reason that matters — the two agree by construction, not by checking.
 *
 * `YieldRecordDTOSchema` is the proof. It shipped registered in the spec while
 * omitting `netTonnesStd` and `tPerHaBasis`, two fields `toDto` has always
 * returned, and nothing went red: passthrough admitted them silently and no
 * operation referenced the schema, so no snapshot covered it.
 *
 * So this test runs the actual mapper, puts its output through JSON (which is
 * what the wire does — `Date` becomes a string, `Decimal` becomes a string),
 * and parses THAT with the published schema made **strict**. Strict is the
 * whole point: a field the mapper gains and the schema does not know about
 * fails here rather than passing invisibly.
 *
 * Both projections are exercised, because the interesting claims are about
 * optionality. `description` and `valuationNotes` are absent from list rows by
 * deliberate server-side decisions (encrypted commercial text, write-gated
 * renderer) and present on a single read. A schema that made them required
 * would be wrong for the list; one that made everything optional would tell a
 * client nothing. The pair of fixtures pins which is which.
 */
import { Prisma } from '@prisma/client';
import { toDto as toCostEntryDto } from '@/app-layer/usecases/cost-entry';
import { toDto as toYieldRecordDto } from '@/app-layer/usecases/yield-record';
import { CostEntryDTOSchema, YieldRecordDTOSchema } from '@/lib/dto/grain.dto';

/** What the wire does to a mapper's output. */
const overTheWire = (v: unknown) => JSON.parse(JSON.stringify(v));

const D = (n: string) => new Prisma.Decimal(n);
const AT = new Date('2026-03-04T05:06:07.000Z');

/** Relations, as both grain projections include them. */
const COST_RELATIONS = {
    planting: { id: 'pl_1', successionNumber: 2, cropPlan: { name: 'Wheat 2026' } },
    season: { id: 'se_1', name: '2026' },
    location: { id: 'lo_1', name: 'North' },
    parcel: { id: 'pa_1', name: 'Block A' },
    item: { id: 'it_1', name: 'Urea', category: 'FERTILIZER' },
    invoiceFile: { id: 'fi_1', originalName: 'inv.pdf', mimeType: 'application/pdf', sizeBytes: 1024 },
} as const;

const COST_SCALARS = {
    id: 'ce_1',
    category: 'FERTILIZER' as const,
    amount: D('1234.56'),
    currency: 'BGN',
    incurredOn: AT,
    supplier: 'Agri Ltd',
    invoiceFileId: 'fi_1',
    plantingId: 'pl_1',
    seasonId: 'se_1',
    locationId: 'lo_1',
    parcelId: 'pa_1',
    leaseId: null,
    itemId: 'it_1',
    allocationBasis: 'PARCEL_SUBSET' as const,
    allocationParcels: [{ parcelId: 'pa_9' }, { parcelId: 'pa_3' }],
    createdByUserId: 'usr_1',
    createdAt: AT,
    updatedAt: AT,
};

describe('CostEntryDTOSchema matches cost-entry.ts::toDto', () => {
    it('accepts a LIST row (no `description` projected) under strict parsing', () => {
        const wire = overTheWire(toCostEntryDto({ ...COST_SCALARS, ...COST_RELATIONS }));
        const r = CostEntryDTOSchema.strict().safeParse(wire);
        if (!r.success) throw new Error(`list row rejected:\n${JSON.stringify(r.error.issues, null, 2)}`);
        // `description` must be genuinely ABSENT, not null — a client is told
        // to distinguish "not sent here" from "this entry has none".
        expect('description' in wire).toBe(false);
    });

    it('accepts a SINGLE-READ row (with `description`) under strict parsing', () => {
        const wire = overTheWire(
            toCostEntryDto({ ...COST_SCALARS, ...COST_RELATIONS, description: 'Spring top-dress' }),
        );
        const r = CostEntryDTOSchema.strict().safeParse(wire);
        if (!r.success) throw new Error(`detail row rejected:\n${JSON.stringify(r.error.issues, null, 2)}`);
        expect(wire.description).toBe('Spring top-dress');
    });

    it('documents the flattening the schema promises', () => {
        const wire = overTheWire(toCostEntryDto({ ...COST_SCALARS, ...COST_RELATIONS }));
        // Sorted, and ids only — the join rows never reach the wire.
        expect(wire.allocationParcelIds).toEqual(['pa_3', 'pa_9']);
        expect('allocationParcels' in wire).toBe(false);
        // Decimal → NUMBER here (the mapper's `dec`), not the string a raw
        // Prisma Decimal would serialise to.
        expect(typeof wire.amount).toBe('number');
    });

    it('an absent amount reads as 0, never null', () => {
        const wire = overTheWire(toCostEntryDto({ ...COST_SCALARS, ...COST_RELATIONS, amount: D('0') }));
        expect(wire.amount).toBe(0);
        expect(CostEntryDTOSchema.strict().safeParse(wire).success).toBe(true);
    });
});

const YIELD_RELATIONS = {
    planting: { id: 'pl_1', successionNumber: 2 },
    location: { id: 'lo_1', name: 'North' },
    season: { id: 'se_1', name: '2026' },
} as const;

const YIELD_SCALARS = {
    id: 'yr_1',
    plantingId: 'pl_1',
    locationId: 'lo_1',
    seasonId: 'se_1',
    commodity: 'Wheat',
    harvestedAt: AT,
    grossTonnes: D('100'),
    moisturePct: D('14.5'),
    areaHa: D('25'),
    createdAt: AT,
    updatedAt: AT,
};

describe('YieldRecordDTOSchema matches yield-record.ts::toDto', () => {
    it('accepts a LIST row (no `valuationNotes`) under strict parsing', () => {
        const wire = overTheWire(
            toYieldRecordDto({ ...YIELD_SCALARS, netTonnesStd: D('96'), ...YIELD_RELATIONS }),
        );
        const r = YieldRecordDTOSchema.strict().safeParse(wire);
        if (!r.success) throw new Error(`list row rejected:\n${JSON.stringify(r.error.issues, null, 2)}`);
        expect('valuationNotes' in wire).toBe(false);
    });

    it('accepts a SINGLE-READ row (with `valuationNotes`) under strict parsing', () => {
        const wire = overTheWire(
            toYieldRecordDto({
                ...YIELD_SCALARS,
                netTonnesStd: D('96'),
                valuationNotes: 'sold forward',
                ...YIELD_RELATIONS,
            }),
        );
        const r = YieldRecordDTOSchema.strict().safeParse(wire);
        if (!r.success) throw new Error(`detail row rejected:\n${JSON.stringify(r.error.issues, null, 2)}`);
    });

    /**
     * The two fields the published schema was missing, and the reason it
     * mattered: `tPerHa` is NOT grossTonnes/areaHa whenever a standardised
     * tonnage exists, and only `tPerHaBasis` says so.
     */
    it('carries the basis, and the basis follows netTonnesStd', () => {
        const standardised = overTheWire(
            toYieldRecordDto({ ...YIELD_SCALARS, netTonnesStd: D('96'), ...YIELD_RELATIONS }),
        );
        expect(standardised.netTonnesStd).toBe(96);
        expect(standardised.tPerHaBasis).toBe('standard-moisture');
        // 96 / 25 — the STANDARDISED tonnage, not the gross 100.
        expect(standardised.tPerHa).toBeCloseTo(3.84, 5);

        const gross = overTheWire(
            toYieldRecordDto({ ...YIELD_SCALARS, netTonnesStd: null, ...YIELD_RELATIONS }),
        );
        expect(gross.tPerHaBasis).toBe('gross');
        expect(gross.tPerHa).toBeCloseTo(4, 5); // 100 / 25

        // The same area and the same record, two different t/ha. Without the
        // basis on the wire a client cannot tell these apart — which is what
        // the spec asked of it until now.
        expect(standardised.tPerHa).not.toBeCloseTo(gross.tPerHa, 5);
        for (const w of [standardised, gross]) {
            expect(YieldRecordDTOSchema.strict().safeParse(w).success).toBe(true);
        }
    });

    it('a zero area yields null t/ha rather than a divide-by-zero figure', () => {
        const wire = overTheWire(
            toYieldRecordDto({ ...YIELD_SCALARS, areaHa: D('0'), netTonnesStd: null, ...YIELD_RELATIONS }),
        );
        expect(wire.tPerHa).toBeNull();
        expect(YieldRecordDTOSchema.strict().safeParse(wire).success).toBe(true);
    });
});
