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
 */
import { NewVendorFormSchema } from '@/lib/schemas/vendor-form';
import {
    NewAssetFormSchema,
    ASSET_TYPE_VALUES,
    ASSET_STATUS_VALUES,
    ASSET_CRITICALITY_VALUES,
} from '@/lib/schemas/asset-form';
import { NewAuditFormSchema } from '@/lib/schemas/audit-form';

describe('NewVendorFormSchema', () => {
    const valid = { name: 'Acme Ltd', criticality: 'HIGH' as const, status: 'ACTIVE' as const };

    it('applies defaults for every omitted optional field', () => {
        const r = NewVendorFormSchema.safeParse(valid);
        expect(r.success).toBe(true);
        if (r.success) {
            // Defaults matter: the form binds these directly, and `undefined`
            // in a controlled input is what produces React's uncontrolled warning.
            expect(r.data.legalName).toBe('');
            expect(r.data.websiteUrl).toBe('');
            expect(r.data.isSubprocessor).toBe(false);
            expect(r.data.nextReviewAt).toBe('');
        }
    });

    it('requires a name and trims it', () => {
        expect(NewVendorFormSchema.safeParse({ ...valid, name: '   ' }).success).toBe(false);
        const r = NewVendorFormSchema.safeParse({ ...valid, name: '  Acme  ' });
        if (r.success) expect(r.data.name).toBe('Acme');
    });

    describe('websiteUrl — empty-string-tolerant URL', () => {
        // The refine deliberately treats '' as valid, preserving the pre-B6
        // behaviour where the field was only sent when non-empty.
        it('accepts an empty string', () => {
            expect(NewVendorFormSchema.safeParse({ ...valid, websiteUrl: '' }).success).toBe(true);
        });

        it('accepts a real URL', () => {
            expect(
                NewVendorFormSchema.safeParse({ ...valid, websiteUrl: 'https://acme.example' }).success,
            ).toBe(true);
        });

        it('rejects a non-URL (the try/catch branch)', () => {
            const r = NewVendorFormSchema.safeParse({ ...valid, websiteUrl: 'acme dot com' });
            expect(r.success).toBe(false);
            if (!r.success) expect(JSON.stringify(r.error.issues)).toMatch(/valid URL or empty/);
        });

        it('rejects an over-long URL before parsing it', () => {
            const long = `https://e.example/${'x'.repeat(1100)}`;
            expect(NewVendorFormSchema.safeParse({ ...valid, websiteUrl: long }).success).toBe(false);
        });
    });

    describe('date fields — YYYY-MM-DD or empty', () => {
        it('accepts empty and a well-formed date', () => {
            expect(NewVendorFormSchema.safeParse({ ...valid, nextReviewAt: '' }).success).toBe(true);
            expect(
                NewVendorFormSchema.safeParse({ ...valid, nextReviewAt: '2026-07-27' }).success,
            ).toBe(true);
        });

        it('rejects other date shapes', () => {
            for (const bad of ['27/07/2026', '2026-7-1', 'soon']) {
                const r = NewVendorFormSchema.safeParse({ ...valid, contractRenewalAt: bad });
                expect(r.success).toBe(false);
            }
        });
    });

    describe('enums', () => {
        it.each(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])('accepts criticality %s', (c) => {
            expect(NewVendorFormSchema.safeParse({ ...valid, criticality: c }).success).toBe(true);
        });

        it('rejects an unknown criticality', () => {
            expect(NewVendorFormSchema.safeParse({ ...valid, criticality: 'SEVERE' }).success).toBe(false);
        });

        it('accepts only ACTIVE or ONBOARDING as a new-vendor status', () => {
            expect(NewVendorFormSchema.safeParse({ ...valid, status: 'ONBOARDING' }).success).toBe(true);
            // A vendor cannot be created already terminated.
            expect(NewVendorFormSchema.safeParse({ ...valid, status: 'TERMINATED' }).success).toBe(false);
        });

        it('treats dataAccess as optional-with-allowlist', () => {
            expect(NewVendorFormSchema.safeParse({ ...valid, dataAccess: '' }).success).toBe(true);
            expect(NewVendorFormSchema.safeParse({ ...valid, dataAccess: 'HIGH' }).success).toBe(true);
            expect(NewVendorFormSchema.safeParse({ ...valid, dataAccess: 'TOTAL' }).success).toBe(false);
        });
    });
});

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
