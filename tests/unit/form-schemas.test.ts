/**
 * Zero-coverage zod contracts, wave 2: the client-side form schemas in
 * `src/lib/schemas/`.
 *
 * These are the "frontend-safe" mirrors of the server contracts (B6) — the
 * server still re-validates, so they are a UX layer. That makes them easy to
 * under-test and easy to drift from the server rule they mirror, which is
 * exactly why they are worth pinning.
 *
 * They also carry the most interesting branches in the untested set: hand-rolled
 * `.refine()` validators with try/catch URL parsing, a regex date guard, and a
 * bounded year window. Each of those is a branch that nothing exercised.
 *
 * The NewVendorFormSchema block went with the GRC teardown; the audit block
 * follows when `audit-form.ts` is deleted in the same tranche as its schema.
 */
import {
    NewAssetFormSchema,
    ASSET_TYPE_VALUES,
    ASSET_STATUS_VALUES,
    ASSET_CRITICALITY_VALUES,
} from '@/lib/schemas/asset-form';
import { NewAuditFormSchema } from '@/lib/schemas/audit-form';

describe('NewAssetFormSchema', () => {
    const valid = { name: 'Combine 1', type: ASSET_TYPE_VALUES[0] };

    it('defaults status to ACTIVE and leaves criticality unset', () => {
        const r = NewAssetFormSchema.safeParse(valid);
        expect(r.success).toBe(true);
        if (r.success) {
            expect(r.data.status).toBe('ACTIVE');
            expect(r.data.criticality).toBeUndefined();
        }
    });

    it('requires a name and a known type', () => {
        expect(NewAssetFormSchema.safeParse({ ...valid, name: '' }).success).toBe(false);
        expect(NewAssetFormSchema.safeParse({ ...valid, type: 'SPACESHIP' }).success).toBe(false);
    });

    it.each([...ASSET_STATUS_VALUES])('accepts status %s', (status) => {
        expect(NewAssetFormSchema.safeParse({ ...valid, status }).success).toBe(true);
    });

    it.each([...ASSET_CRITICALITY_VALUES])('accepts criticality %s', (criticality) => {
        expect(NewAssetFormSchema.safeParse({ ...valid, criticality }).success).toBe(true);
    });

    describe('year window', () => {
        it('rejects a year before 1900 and accepts the boundary', () => {
            expect(NewAssetFormSchema.safeParse({ ...valid, year: 1899 }).success).toBe(false);
            expect(NewAssetFormSchema.safeParse({ ...valid, year: 1900 }).success).toBe(true);
        });

        it('allows next year but not beyond', () => {
            // Machinery is often bought as a next-model-year unit, so the
            // ceiling is deliberately CURRENT_YEAR + 1 rather than today.
            expect(NewAssetFormSchema.safeParse({ ...valid, year: 2027 }).success).toBe(true);
            expect(NewAssetFormSchema.safeParse({ ...valid, year: 2028 }).success).toBe(false);
        });

        it('rejects a fractional year', () => {
            const r = NewAssetFormSchema.safeParse({ ...valid, year: 2020.5 });
            expect(r.success).toBe(false);
            if (!r.success) expect(JSON.stringify(r.error.issues)).toMatch(/whole year/);
        });
    });

    describe('purchase cost', () => {
        it('accepts zero and rejects negative', () => {
            expect(NewAssetFormSchema.safeParse({ ...valid, purchaseCost: 0 }).success).toBe(true);
            expect(NewAssetFormSchema.safeParse({ ...valid, purchaseCost: -1 }).success).toBe(false);
        });

        it('caps at a sane ceiling', () => {
            expect(NewAssetFormSchema.safeParse({ ...valid, purchaseCost: 1_000_000_001 }).success).toBe(false);
        });
    });
});

describe('NewAuditFormSchema', () => {
    it('requires a title', () => {
        expect(NewAuditFormSchema.safeParse({}).success).toBe(false);
        expect(NewAuditFormSchema.safeParse({ title: '  ' }).success).toBe(false);
    });

    it('defaults generateChecklist to true', () => {
        // The default is load-bearing: an audit created without a checklist is
        // an empty shell, so opting OUT must be explicit.
        const r = NewAuditFormSchema.safeParse({ title: 'ISO 27001 internal' });
        expect(r.success).toBe(true);
        if (r.success) {
            expect(r.data.generateChecklist).toBe(true);
            expect(r.data.frameworkKey).toBe('');
        }
    });

    it('allows opting out of the checklist', () => {
        const r = NewAuditFormSchema.safeParse({ title: 'Spot check', generateChecklist: false });
        if (r.success) expect(r.data.generateChecklist).toBe(false);
    });

    it('bounds the free-text fields', () => {
        expect(NewAuditFormSchema.safeParse({ title: 'T', scope: 'x'.repeat(4001) }).success).toBe(false);
        expect(NewAuditFormSchema.safeParse({ title: 'T', auditors: 'x'.repeat(1025) }).success).toBe(false);
        expect(NewAuditFormSchema.safeParse({ title: 'T', frameworkKey: 'x'.repeat(61) }).success).toBe(false);
    });

    it('treats an empty frameworkKey as "no link"', () => {
        // The API maps '' and undefined alike to null — pinning it here so the
        // form and the API cannot drift on what "unlinked" means.
        const r = NewAuditFormSchema.safeParse({ title: 'T', frameworkKey: '' });
        expect(r.success).toBe(true);
        if (r.success) expect(r.data.frameworkKey).toBe('');
    });
});
