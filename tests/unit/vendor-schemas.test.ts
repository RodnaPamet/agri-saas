import {
    CreateVendorSchema, UpdateVendorSchema, CreateVendorDocumentSchema,
    StartAssessmentSchema, SaveAssessmentAnswersSchema, DecideAssessmentSchema, AddVendorLinkSchema,
} from '../../src/lib/schemas';

describe('Vendor Schemas', () => {
    describe('CreateVendorSchema', () => {
        it('validates minimal valid input', () => {
            const r = CreateVendorSchema.safeParse({ name: 'AWS' });
            expect(r.success).toBe(true);
        });

        it('accepts all optional fields', () => {
            const r = CreateVendorSchema.safeParse({
                name: 'AWS', legalName: 'Amazon Web Services Inc.',
                websiteUrl: 'https://aws.amazon.com', domain: 'aws.amazon.com',
                country: 'US', criticality: 'HIGH', dataAccess: 'HIGH',
                isSubprocessor: true, tags: ['cloud', 'iaas'],
                nextReviewAt: '2025-06-01', contractRenewalAt: '2026-01-01',
            });
            expect(r.success).toBe(true);
        });

        it('rejects empty name', () => {
            expect(CreateVendorSchema.safeParse({ name: '' }).success).toBe(false);
        });

        it('rejects invalid criticality', () => {
            expect(CreateVendorSchema.safeParse({ name: 'X', criticality: 'UNKNOWN' }).success).toBe(false);
        });

        it('rejects invalid websiteUrl', () => {
            expect(CreateVendorSchema.safeParse({ name: 'X', websiteUrl: 'not-a-url' }).success).toBe(false);
        });

        it('strips unknown fields', () => {
            const r = CreateVendorSchema.parse({ name: 'Y', secret: 'hack' });
            expect(r).not.toHaveProperty('secret');
        });
    });

    describe('UpdateVendorSchema', () => {
        it('validates partial update', () => {
            expect(UpdateVendorSchema.safeParse({ criticality: 'CRITICAL' }).success).toBe(true);
        });

        it('allows nullable fields', () => {
            expect(UpdateVendorSchema.safeParse({ legalName: null }).success).toBe(true);
        });

        it('allows residualRisk', () => {
            expect(UpdateVendorSchema.safeParse({ residualRisk: 'LOW' }).success).toBe(true);
        });
    });

    describe('CreateVendorDocumentSchema', () => {
        it('validates valid doc', () => {
            expect(CreateVendorDocumentSchema.safeParse({ type: 'CONTRACT' }).success).toBe(true);
        });

        it('accepts all doc types', () => {
            for (const t of ['CONTRACT', 'SOC2', 'ISO_CERT', 'DPA', 'SECURITY_POLICY', 'PEN_TEST', 'OTHER']) {
                expect(CreateVendorDocumentSchema.safeParse({ type: t }).success).toBe(true);
            }
        });

        it('rejects invalid type', () => {
            expect(CreateVendorDocumentSchema.safeParse({ type: 'INVALID' }).success).toBe(false);
        });

        it('accepts valid externalUrl', () => {
            expect(CreateVendorDocumentSchema.safeParse({ type: 'SOC2', externalUrl: 'https://example.com/report.pdf' }).success).toBe(true);
        });
    });

    describe('StartAssessmentSchema', () => {
        it('validates with templateKey', () => {
            expect(StartAssessmentSchema.safeParse({ templateKey: 'VENDOR_BASELINE' }).success).toBe(true);
        });

        it('rejects empty templateKey', () => {
            expect(StartAssessmentSchema.safeParse({ templateKey: '' }).success).toBe(false);
        });
    });

    describe('SaveAssessmentAnswersSchema', () => {
        it('validates answers array', () => {
            const r = SaveAssessmentAnswersSchema.safeParse({
                answers: [
                    { questionId: 'q1', answerJson: true },
                    { questionId: 'q2', answerJson: 'NO' },
                ],
            });
            expect(r.success).toBe(true);
        });

        it('rejects empty answers', () => {
            expect(SaveAssessmentAnswersSchema.safeParse({ answers: [] }).success).toBe(false);
        });
    });

    describe('DecideAssessmentSchema', () => {
        it('accepts APPROVED', () => {
            expect(DecideAssessmentSchema.safeParse({ decision: 'APPROVED' }).success).toBe(true);
        });

        it('accepts REJECTED with notes', () => {
            expect(DecideAssessmentSchema.safeParse({ decision: 'REJECTED', notes: 'Too risky' }).success).toBe(true);
        });

        it('rejects invalid decision', () => {
            expect(DecideAssessmentSchema.safeParse({ decision: 'MAYBE' }).success).toBe(false);
        });
    });

    describe('AddVendorLinkSchema', () => {
        it('validates valid link', () => {
            expect(AddVendorLinkSchema.safeParse({ entityType: 'ASSET', entityId: 'asset-1' }).success).toBe(true);
        });

        it('accepts optional relation', () => {
            const r = AddVendorLinkSchema.safeParse({ entityType: 'ASSET', entityId: 'asset-1', relation: 'MITIGATES' });
            expect(r.success).toBe(true);
        });

        it('rejects invalid entityType', () => {
            expect(AddVendorLinkSchema.safeParse({ entityType: 'INVALID', entityId: 'x' }).success).toBe(false);
        });
    });
});
