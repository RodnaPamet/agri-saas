/**
 * Audit Issue Schema Tests — Updated for unified Task model.
 * 
 * Issue-specific fields (findingSource, practiceGapType, remediationPlan, etc.)
 * are no longer part of the schema — they're stored in metadataJson.
 * 
 * Tests updated to reflect the new unified CreateTaskSchema (aliased as CreateIssueSchema).
 */
import { CreateIssueSchema, UpdateIssueSchema, SetIssueStatusSchema, CreateBundleSchema, AddBundleItemSchema } from '../../src/lib/schemas';

describe('Audit Issue Schemas', () => {
    describe('CreateIssueSchema audit fields', () => {
        it('accepts AUDIT_FINDING type', () => {
            const result = CreateIssueSchema.safeParse({
                title: 'Finding 1', type: 'AUDIT_FINDING',
            });
            expect(result.success).toBe(true);
        });

        it('accepts PRACTICE_GAP type', () => {
            const result = CreateIssueSchema.safeParse({
                title: 'Gap 1', type: 'PRACTICE_GAP',
            });
            expect(result.success).toBe(true);
        });

        it('accepts metadataJson for extended fields', () => {
            const result = CreateIssueSchema.safeParse({
                title: 'Finding 2', type: 'AUDIT_FINDING',
                metadataJson: {
                    findingSource: 'EXTERNAL_AUDITOR',
                    remediationPlan: 'Fix all the things',
                    remediationOwnerUserId: 'user-123',
                    remediationDueAt: '2025-06-01',
                },
            });
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.metadataJson.findingSource).toBe('EXTERNAL_AUDITOR');
            }
        });

        it('strips unknown fields', () => {
            const result = CreateIssueSchema.parse({
                title: 'F', type: 'TASK',
                secretField: 'should be stripped',
            });
            expect(result).not.toHaveProperty('secretField');
        });

        it('accepts source field', () => {
            const result = CreateIssueSchema.safeParse({
                title: 'Finding 3', type: 'AUDIT_FINDING',
                source: 'AUDIT',
            });
            expect(result.success).toBe(true);
        });

        it('rejects invalid source', () => {
            const result = CreateIssueSchema.safeParse({
                title: 'Finding 4', type: 'AUDIT_FINDING',
                source: 'INVALID_SOURCE',
            });
            expect(result.success).toBe(false);
        });

        it('accepts practiceId', () => {
            const result = CreateIssueSchema.safeParse({
                title: 'Finding 5', type: 'AUDIT_FINDING',
                practiceId: 'ctrl-1',
            });
            expect(result.success).toBe(true);
        });
    });

    describe('UpdateIssueSchema updated fields', () => {
        it('accepts metadataJson updates', () => {
            const result = UpdateIssueSchema.safeParse({ metadataJson: { remediationPlan: 'Updated plan' } });
            expect(result.success).toBe(true);
        });

        it('accepts practiceId update', () => {
            const result = UpdateIssueSchema.safeParse({ practiceId: 'ctrl-2' });
            expect(result.success).toBe(true);
        });

        it('accepts null practiceId', () => {
            const result = UpdateIssueSchema.safeParse({ practiceId: null });
            expect(result.success).toBe(true);
        });
    });

    describe('SetIssueStatusSchema new statuses', () => {
        it('accepts CANCELED', () => {
            const result = SetIssueStatusSchema.safeParse({ status: 'CANCELED' });
            expect(result.success).toBe(true);
        });

        it('still accepts base statuses', () => {
            for (const status of ['OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED', 'RESOLVED', 'CLOSED']) {
                expect(SetIssueStatusSchema.safeParse({ status }).success).toBe(true);
            }
        });

        it('rejects old Issue-specific statuses', () => {
            // REMEDIATION_IN_PROGRESS and READY_FOR_RETEST are no longer valid statuses
            expect(SetIssueStatusSchema.safeParse({ status: 'REMEDIATION_IN_PROGRESS' }).success).toBe(false);
            expect(SetIssueStatusSchema.safeParse({ status: 'READY_FOR_RETEST' }).success).toBe(false);
        });
    });

    describe('CreateBundleSchema', () => {
        it('validates valid bundle name', () => {
            expect(CreateBundleSchema.safeParse({ name: 'Q1 2025 Audit' }).success).toBe(true);
        });

        it('rejects empty name', () => {
            expect(CreateBundleSchema.safeParse({ name: '' }).success).toBe(false);
        });

        it('rejects name over 200 chars', () => {
            expect(CreateBundleSchema.safeParse({ name: 'x'.repeat(201) }).success).toBe(false);
        });

        it('strips unknown fields', () => {
            const result = CreateBundleSchema.parse({ name: 'Test', extra: 'field' });
            expect(result).not.toHaveProperty('extra');
        });
    });

    describe('AddBundleItemSchema', () => {
        it('validates FILE entity', () => {
            const result = AddBundleItemSchema.safeParse({ entityType: 'FILE', entityId: 'file-1' });
            expect(result.success).toBe(true);
        });

        it('validates EVIDENCE entity with label', () => {
            const result = AddBundleItemSchema.safeParse({
                entityType: 'EVIDENCE', entityId: 'ev-1', label: 'SOC2 Report',
            });
            expect(result.success).toBe(true);
        });

        it('validates INTEGRATION entity', () => {
            const result = AddBundleItemSchema.safeParse({ entityType: 'INTEGRATION', entityId: 'int-1' });
            expect(result.success).toBe(true);
        });

        it('rejects invalid entityType', () => {
            expect(AddBundleItemSchema.safeParse({ entityType: 'INVALID', entityId: 'x' }).success).toBe(false);
        });

        it('rejects empty entityId', () => {
            expect(AddBundleItemSchema.safeParse({ entityType: 'FILE', entityId: '' }).success).toBe(false);
        });
    });
});
