/**
 * Audit Event Schema — Unit Tests
 *
 * Validates the Zod schemas for structured audit event payloads.
 * These tests ensure the canonical contract is enforced and deterministic.
 */
import {
    AuditDetailsSchema,
    EntityLifecycleSchema,
    StatusChangeSchema,
    RelationshipSchema,
    AccessSchema,
    DataLifecycleSchema,
    CustomSchema,
} from '../../src/lib/audit/event-schema';

describe('Audit Event Schema', () => {
    // ── Entity Lifecycle ──

    describe('EntityLifecycleSchema', () => {
        test('accepts valid entity_lifecycle payload', () => {
            const payload = {
                category: 'entity_lifecycle' as const,
                entityName: 'Vendor',
                operation: 'created' as const,
            };
            const result = EntityLifecycleSchema.safeParse(payload);
            expect(result.success).toBe(true);
        });

        test('accepts payload with all optional fields', () => {
            const payload = {
                category: 'entity_lifecycle' as const,
                entityName: 'Practice',
                operation: 'updated' as const,
                changedFields: ['status', 'effectiveness'],
                before: { status: 'NOT_STARTED' },
                after: { status: 'IN_PROGRESS' },
                summary: 'Practice status updated',
            };
            const result = EntityLifecycleSchema.safeParse(payload);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.changedFields).toEqual(['status', 'effectiveness']);
            }
        });

        test('rejects payload with missing entityName', () => {
            const payload = {
                category: 'entity_lifecycle',
                operation: 'created',
            };
            const result = EntityLifecycleSchema.safeParse(payload);
            expect(result.success).toBe(false);
        });

        test('rejects payload with invalid operation', () => {
            const payload = {
                category: 'entity_lifecycle',
                entityName: 'Risk',
                operation: 'destroyed', // not a valid operation
            };
            const result = EntityLifecycleSchema.safeParse(payload);
            expect(result.success).toBe(false);
        });

        test('rejects payload with extra unknown fields (strict mode)', () => {
            const payload = {
                category: 'entity_lifecycle',
                entityName: 'Risk',
                operation: 'created',
                secretData: 'should-not-be-here',
            };
            const result = EntityLifecycleSchema.safeParse(payload);
            expect(result.success).toBe(false);
        });
    });

    // ── Status Change ──

    describe('StatusChangeSchema', () => {
        test('accepts valid status_change payload', () => {
            const payload = {
                category: 'status_change' as const,
                entityName: 'Policy',
                fromStatus: 'DRAFT',
                toStatus: 'APPROVED',
            };
            const result = StatusChangeSchema.safeParse(payload);
            expect(result.success).toBe(true);
        });

        test('accepts null fromStatus (initial status)', () => {
            const payload = {
                category: 'status_change' as const,
                entityName: 'Task',
                fromStatus: null,
                toStatus: 'OPEN',
            };
            const result = StatusChangeSchema.safeParse(payload);
            expect(result.success).toBe(true);
        });

        test('accepts payload with reason', () => {
            const payload = {
                category: 'status_change' as const,
                entityName: 'Vendor',
                fromStatus: 'ACTIVE',
                toStatus: 'OFFBOARDING',
                reason: 'Contract expired',
            };
            const result = StatusChangeSchema.safeParse(payload);
            expect(result.success).toBe(true);
        });

        test('rejects empty toStatus', () => {
            const payload = {
                category: 'status_change',
                entityName: 'Policy',
                fromStatus: 'DRAFT',
                toStatus: '',
            };
            const result = StatusChangeSchema.safeParse(payload);
            expect(result.success).toBe(false);
        });
    });

    // ── Relationship ──

    describe('RelationshipSchema', () => {
        test('accepts valid linked relationship', () => {
            const payload = {
                category: 'relationship' as const,
                operation: 'linked' as const,
                sourceEntity: 'Practice',
                sourceId: 'ctrl-123',
                targetEntity: 'Risk',
                targetId: 'risk-456',
            };
            const result = RelationshipSchema.safeParse(payload);
            expect(result.success).toBe(true);
        });

        test('accepts relationship with relation type', () => {
            const payload = {
                category: 'relationship' as const,
                operation: 'linked' as const,
                sourceEntity: 'Vendor',
                sourceId: 'v-1',
                targetEntity: 'Asset',
                targetId: 'a-1',
                relation: 'PROVIDES_SERVICE_TO',
            };
            const result = RelationshipSchema.safeParse(payload);
            expect(result.success).toBe(true);
        });

        test('rejects missing targetId', () => {
            const payload = {
                category: 'relationship',
                operation: 'linked',
                sourceEntity: 'Practice',
                sourceId: 'ctrl-123',
                targetEntity: 'Risk',
            };
            const result = RelationshipSchema.safeParse(payload);
            expect(result.success).toBe(false);
        });
    });

    // ── Access ──

    describe('AccessSchema', () => {
        test('accepts valid login event', () => {
            const payload = {
                category: 'access' as const,
                operation: 'login' as const,
            };
            const result = AccessSchema.safeParse(payload);
            expect(result.success).toBe(true);
        });

        test('accepts session revoked with details', () => {
            const payload = {
                category: 'access' as const,
                operation: 'session_revoked' as const,
                targetUserId: 'user-abc',
                detail: 'Revoked due to password change',
            };
            const result = AccessSchema.safeParse(payload);
            expect(result.success).toBe(true);
        });

        test('rejects invalid operation', () => {
            const payload = {
                category: 'access',
                operation: 'hacked',
            };
            const result = AccessSchema.safeParse(payload);
            expect(result.success).toBe(false);
        });
    });

    // ── Data Lifecycle ──

    describe('DataLifecycleSchema', () => {
        test('accepts valid data purge event', () => {
            const payload = {
                category: 'data_lifecycle' as const,
                operation: 'purged' as const,
                recordCount: 42,
                model: 'Evidence',
                reason: 'soft_delete_grace_expired',
                graceDays: 90,
            };
            const result = DataLifecycleSchema.safeParse(payload);
            expect(result.success).toBe(true);
        });

        test('accepts minimal data lifecycle event', () => {
            const payload = {
                category: 'data_lifecycle' as const,
                operation: 'archived' as const,
            };
            const result = DataLifecycleSchema.safeParse(payload);
            expect(result.success).toBe(true);
        });

        test('rejects negative recordCount', () => {
            const payload = {
                category: 'data_lifecycle',
                operation: 'purged',
                recordCount: -5,
            };
            const result = DataLifecycleSchema.safeParse(payload);
            expect(result.success).toBe(false);
        });
    });

    // ── Custom ──

    describe('CustomSchema', () => {
        test('accepts custom event with arbitrary fields', () => {
            const payload = {
                category: 'custom' as const,
                action: 'VENDOR_ENRICHED',
                provider: 'SecurityScorecard',
                fields: ['companyName', 'country'],
            };
            const result = CustomSchema.safeParse(payload);
            expect(result.success).toBe(true);
        });

        test('accepts minimal custom event', () => {
            const payload = { category: 'custom' as const };
            const result = CustomSchema.safeParse(payload);
            expect(result.success).toBe(true);
        });
    });

    // ── Discriminated Union ──

    describe('AuditDetailsSchema (discriminated union)', () => {
        test('correctly routes entity_lifecycle category', () => {
            const payload = {
                category: 'entity_lifecycle',
                entityName: 'Asset',
                operation: 'deleted',
            };
            const result = AuditDetailsSchema.safeParse(payload);
            expect(result.success).toBe(true);
        });

        test('correctly routes status_change category', () => {
            const payload = {
                category: 'status_change',
                entityName: 'Practice',
                fromStatus: 'NOT_STARTED',
                toStatus: 'IN_PROGRESS',
            };
            const result = AuditDetailsSchema.safeParse(payload);
            expect(result.success).toBe(true);
        });

        test('correctly routes relationship category', () => {
            const payload = {
                category: 'relationship',
                operation: 'unlinked',
                sourceEntity: 'Asset',
                sourceId: 'a1',
                targetEntity: 'Risk',
                targetId: 'r1',
            };
            const result = AuditDetailsSchema.safeParse(payload);
            expect(result.success).toBe(true);
        });

        test('rejects unknown category', () => {
            const payload = {
                category: 'unknown_category',
                data: 'test',
            };
            const result = AuditDetailsSchema.safeParse(payload);
            expect(result.success).toBe(false);
        });

        test('rejects payload without category field', () => {
            const payload = {
                entityName: 'Asset',
                operation: 'created',
            };
            const result = AuditDetailsSchema.safeParse(payload);
            expect(result.success).toBe(false);
        });

        test('validates cross-category: entity_lifecycle fields rejected on status_change', () => {
            const payload = {
                category: 'status_change',
                entityName: 'Policy',
                fromStatus: 'DRAFT',
                toStatus: 'APPROVED',
                operation: 'created', // entity_lifecycle field — should be rejected by strict()
            };
            const result = AuditDetailsSchema.safeParse(payload);
            expect(result.success).toBe(false);
        });
    });
});
