/**
 * `src/app-layer/schemas/grain.schemas.ts` — zod input contracts for the
 * GRAIN module.
 *
 * This file had **zero** coverage: no test imported it, so it counted as 0%
 * against the coverage gate despite being the validation boundary for every
 * grain write. It is also branch-dense — each field's optional / nullable /
 * bounded shape is a branch — so it is one of the highest-leverage files in
 * the untested set.
 *
 * The tests are organised around the four SHARED field shapes rather than
 * per-schema, because that is where the real contracts live:
 *
 *   - `OptionalText`      → the undefined / null / value THREE-state contract
 *   - `ShortText`         → required, non-empty, bounded
 *   - `NonNegativeNumber` → finite, >= 0, nullable
 *   - `DateString`        → min length 8, nullable
 *
 * `.strip()` on every schema is itself a contract: unknown keys must be
 * dropped, not rejected and not passed through to Prisma.
 */
import {
    CreateContractSchema,
    UpdateContractSchema,
    CreateGrainDeliverySchema,
    CreateYieldRecordSchema,
    UpdateYieldRecordSchema,
    CreateBinSchema,
    UpdateBinSchema,
    BlendLotsSchema,
} from '@/app-layer/schemas/grain.schemas';

describe('grain schemas — the three-state optional-text contract', () => {
    // undefined = "don't touch", null = "clear it", value = "set it". Collapsing
    // any two of those is a data-loss bug in an update path.
    it('accepts an omitted optional text field', () => {
        const r = UpdateBinSchema.safeParse({ name: 'Silo 3' });
        expect(r.success).toBe(true);
        if (r.success) expect('description' in r.data).toBe(false);
    });

    it('accepts null to clear an optional text field', () => {
        const r = UpdateBinSchema.safeParse({ description: null });
        expect(r.success).toBe(true);
        if (r.success) expect(r.data.description).toBeNull();
    });

    it('accepts a value', () => {
        const r = UpdateBinSchema.safeParse({ description: 'north yard' });
        expect(r.success).toBe(true);
        if (r.success) expect(r.data.description).toBe('north yard');
    });

    it('rejects an over-long optional text field', () => {
        const r = UpdateBinSchema.safeParse({ description: 'x'.repeat(2001) });
        expect(r.success).toBe(false);
    });
});

describe('grain schemas — required short text', () => {
    it('rejects an empty required name', () => {
        expect(CreateBinSchema.safeParse({ name: '' }).success).toBe(false);
    });

    it('rejects a missing required name', () => {
        expect(CreateBinSchema.safeParse({}).success).toBe(false);
    });

    it('rejects an over-long name', () => {
        expect(CreateBinSchema.safeParse({ name: 'x'.repeat(201) }).success).toBe(false);
    });

    it('accepts a minimal valid bin', () => {
        const r = CreateBinSchema.safeParse({ name: 'Silo 3' });
        expect(r.success).toBe(true);
    });
});

describe('grain schemas — non-negative numbers', () => {
    it('accepts zero capacity', () => {
        // Zero is meaningful: a bin whose capacity is not yet measured.
        expect(CreateBinSchema.safeParse({ name: 'B', capacityTonnes: 0 }).success).toBe(true);
    });

    it('rejects a negative capacity', () => {
        const r = CreateBinSchema.safeParse({ name: 'B', capacityTonnes: -1 });
        expect(r.success).toBe(false);
        if (!r.success) {
            expect(JSON.stringify(r.error.issues)).toMatch(/zero or positive/);
        }
    });

    it('rejects a non-finite capacity', () => {
        expect(CreateBinSchema.safeParse({ name: 'B', capacityTonnes: Infinity }).success).toBe(false);
        expect(CreateBinSchema.safeParse({ name: 'B', capacityTonnes: NaN }).success).toBe(false);
    });

    it('accepts null capacity (explicitly unknown)', () => {
        expect(CreateBinSchema.safeParse({ name: 'B', capacityTonnes: null }).success).toBe(true);
    });
});

describe('grain schemas — bin kind', () => {
    it.each(['BIN', 'STORAGE'])('accepts kind %s', (kind) => {
        expect(CreateBinSchema.safeParse({ name: 'B', kind }).success).toBe(true);
    });

    it('rejects a FIELD as a bin kind', () => {
        // A FIELD is a growing area, never a store — the usecase relies on the
        // schema keeping it out.
        expect(CreateBinSchema.safeParse({ name: 'B', kind: 'FIELD' }).success).toBe(false);
    });
});

describe('grain schemas — contracts', () => {
    it('requires a counterparty and a type', () => {
        expect(CreateContractSchema.safeParse({}).success).toBe(false);
    });

    it('accepts a minimal SALE contract', () => {
        const r = CreateContractSchema.safeParse({ counterparty: 'Cargill', type: 'SALE' });
        expect(r.success).toBe(true);
    });

    it('rejects an unknown contract type', () => {
        expect(
            CreateContractSchema.safeParse({ counterparty: 'C', type: 'BARTER' }).success,
        ).toBe(false);
    });

    it('rejects a too-short date string', () => {
        // DateString requires >= 8 chars, so "2026-1" cannot be a date.
        const r = CreateContractSchema.safeParse({
            counterparty: 'C',
            type: 'SALE',
            deliveryStart: '2026-1',
        });
        expect(r.success).toBe(false);
    });

    it('accepts null to clear a delivery window', () => {
        const r = UpdateContractSchema.safeParse({ deliveryEnd: null });
        expect(r.success).toBe(true);
    });

    it('strips unknown keys rather than rejecting them', () => {
        // `.strip()` — the route must not forward arbitrary client keys to
        // Prisma, but a stray field is not worth a 400.
        const r = CreateContractSchema.safeParse({
            counterparty: 'C',
            type: 'SALE',
            sneakyTenantId: 'other-tenant',
        });
        expect(r.success).toBe(true);
        if (r.success) expect('sneakyTenantId' in r.data).toBe(false);
    });
});

describe('grain schemas — deliveries and yield records', () => {
    it('requires a contract, a date and a quantity for a delivery', () => {
        expect(CreateGrainDeliverySchema.safeParse({}).success).toBe(false);
        const r = CreateGrainDeliverySchema.safeParse({
            contractId: 'c-1',
            deliveredAt: '2026-07-26',
            tonnes: 12.5,
        });
        expect(r.success).toBe(true);
    });

    it('rejects a delivery with a short date', () => {
        expect(
            CreateGrainDeliverySchema.safeParse({
                contractId: 'c-1',
                deliveredAt: '26-7',
                tonnes: 1,
            }).success,
        ).toBe(false);
    });

    it('accepts a yield record with only optional links', () => {
        const r = CreateYieldRecordSchema.safeParse({ grossTonnes: 10 });
        expect(r.success).toBe(true);
    });

    it('accepts null links on a yield update (clearing an association)', () => {
        const r = UpdateYieldRecordSchema.safeParse({ plantingId: null, locationId: null });
        expect(r.success).toBe(true);
    });

    it('rejects an empty-string id (null means clear, "" means nothing)', () => {
        expect(UpdateYieldRecordSchema.safeParse({ plantingId: '' }).success).toBe(false);
    });
});

describe('grain schemas — blend input bounds', () => {
    it('requires at least one source lot', () => {
        expect(
            BlendLotsSchema.safeParse({ sourceLots: [], outputItemId: 'i-1' }).success,
        ).toBe(false);
    });

    it('accepts a single source lot', () => {
        const r = BlendLotsSchema.safeParse({
            sourceLots: [{ lotId: 'l-1', quantity: 5 }],
            outputItemId: 'i-1',
        });
        expect(r.success).toBe(true);
    });

    it('caps source lots at 50', () => {
        // Each source lot becomes a ledger append plus a genealogy edge inside
        // ONE transaction holding the per-tenant stock advisory lock, so an
        // unbounded list stalls every other stock write to the 5s timeout.
        const lots = (n: number) =>
            Array.from({ length: n }, (_, i) => ({ lotId: `l-${i}`, quantity: 1 }));

        expect(
            BlendLotsSchema.safeParse({ sourceLots: lots(50), outputItemId: 'i-1' }).success,
        ).toBe(true);
        const over = BlendLotsSchema.safeParse({
            sourceLots: lots(51),
            outputItemId: 'i-1',
        });
        expect(over.success).toBe(false);
        if (!over.success) {
            expect(JSON.stringify(over.error.issues)).toMatch(/at most 50 source lots/);
        }
    });

    it('rejects a non-positive blend quantity', () => {
        for (const quantity of [0, -1]) {
            const r = BlendLotsSchema.safeParse({
                sourceLots: [{ lotId: 'l-1', quantity }],
                outputItemId: 'i-1',
            });
            expect(r.success).toBe(false);
        }
    });

    it('accepts an explicit null output location (unassigned blend)', () => {
        const r = BlendLotsSchema.safeParse({
            sourceLots: [{ lotId: 'l-1', quantity: 1 }],
            outputItemId: 'i-1',
            outputLocationId: null,
        });
        expect(r.success).toBe(true);
    });

    it('accepts numeric quality overrides and rejects non-numeric ones', () => {
        const ok = BlendLotsSchema.safeParse({
            sourceLots: [{ lotId: 'l-1', quantity: 1 }],
            outputItemId: 'i-1',
            qualityAttributes: { moisture: 13.5 },
        });
        expect(ok.success).toBe(true);

        const bad = BlendLotsSchema.safeParse({
            sourceLots: [{ lotId: 'l-1', quantity: 1 }],
            outputItemId: 'i-1',
            qualityAttributes: { moisture: 'wet' },
        });
        expect(bad.success).toBe(false);
    });
});
