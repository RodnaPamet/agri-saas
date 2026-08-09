/**
 * JSON Column Validation Tests
 *
 * Verifies:
 * 1. Valid payloads pass centralized schemas
 * 2. Invalid payloads are rejected with typed ValidationError (400)
 * 3. Validation helpers return parsed data or throw
 * 4. All JSON column schemas are centralized in one module
 * 5. Edge cases: null, undefined, empty, oversized
 */
import {
    AuditDetailsJsonSchema,
    MetadataJsonSchema,
    VendorTagsSchema,
    VendorCertificationsSchema,
    IntegrationConfigJsonSchema,
    MappingMetadataJsonSchema,
    TaskMetadataJsonSchema,
    OnboardingStepDataSchema,
    validateAuditDetailsJson,
    validateVendorTags,
    validateVendorCertifications,
    validateTaskMetadata,
    validateIntegrationConfig,
} from '@/app-layer/schemas/json-columns.schemas';
import { ValidationError } from '@/lib/errors/types';

describe('JSON Column Schemas', () => {
    // ─── AuditDetailsJsonSchema ───

    describe('AuditDetailsJsonSchema', () => {
        it('accepts valid entity_lifecycle event', () => {
            const input = {
                category: 'entity_lifecycle',
                entityName: 'Practice',
                operation: 'created',
                summary: 'Practice created',
            };
            expect(AuditDetailsJsonSchema.parse(input)).toMatchObject(input);
        });

        it('accepts valid status_change event', () => {
            const input = {
                category: 'status_change',
                entityName: 'Task',
                fromStatus: 'OPEN',
                toStatus: 'CLOSED',
            };
            expect(AuditDetailsJsonSchema.parse(input)).toMatchObject(input);
        });

        it('accepts valid relationship event', () => {
            const input = {
                category: 'relationship',
                operation: 'linked',
                sourceEntity: 'Practice',
                sourceId: 'ctrl-1',
                targetEntity: 'Risk',
                targetId: 'risk-1',
                relation: 'mitigates',
            };
            expect(AuditDetailsJsonSchema.parse(input)).toMatchObject(input);
        });

        it('accepts valid custom event', () => {
            const input = { category: 'custom', event: 'vendor_enriched' };
            expect(AuditDetailsJsonSchema.parse(input)).toMatchObject(input);
        });

        it('accepts extra fields via passthrough', () => {
            const input = { category: 'custom', event: 'test', extraField: 'value' };
            const result = AuditDetailsJsonSchema.parse(input);
            expect((result as Record<string, unknown>).extraField).toBe('value');
        });

        it('rejects missing category', () => {
            const result = AuditDetailsJsonSchema.safeParse({ entityName: 'X' });
            expect(result.success).toBe(false);
        });

        it('rejects invalid category value', () => {
            const result = AuditDetailsJsonSchema.safeParse({ category: 'INVALID' });
            expect(result.success).toBe(false);
        });
    });

    // ─── VendorTagsSchema ───

    describe('VendorTagsSchema', () => {
        it('accepts valid string array', () => {
            expect(VendorTagsSchema.parse(['soc2', 'hipaa'])).toEqual(['soc2', 'hipaa']);
        });

        it('accepts empty array', () => {
            expect(VendorTagsSchema.parse([])).toEqual([]);
        });

        it('rejects non-array input', () => {
            expect(VendorTagsSchema.safeParse('not-array').success).toBe(false);
        });

        it('rejects array with non-string items', () => {
            expect(VendorTagsSchema.safeParse([123, true]).success).toBe(false);
        });

        it('rejects empty string tag', () => {
            expect(VendorTagsSchema.safeParse(['']).success).toBe(false);
        });

        it('rejects tag over 100 chars', () => {
            expect(VendorTagsSchema.safeParse(['x'.repeat(101)]).success).toBe(false);
        });

        it('rejects more than 50 tags', () => {
            const tags = Array.from({ length: 51 }, (_, i) => `tag-${i}`);
            expect(VendorTagsSchema.safeParse(tags).success).toBe(false);
        });

        it('accepts 50 valid tags', () => {
            const tags = Array.from({ length: 50 }, (_, i) => `tag-${i}`);
            expect(VendorTagsSchema.safeParse(tags).success).toBe(true);
        });
    });

    // ─── VendorCertificationsSchema ───

    describe('VendorCertificationsSchema', () => {
        it('accepts valid certification array', () => {
            const input = [{ name: 'SOC 2 Type II', issuer: 'Deloitte', verified: true }];
            expect(VendorCertificationsSchema.parse(input)).toMatchObject(input);
        });

        it('accepts empty array', () => {
            expect(VendorCertificationsSchema.parse([])).toEqual([]);
        });

        it('rejects certification without name', () => {
            expect(VendorCertificationsSchema.safeParse([{ issuer: 'X' }]).success).toBe(false);
        });
    });

    // ─── MetadataJsonSchema ───

    describe('MetadataJsonSchema', () => {
        it('accepts plain object', () => {
            expect(MetadataJsonSchema.parse({ key: 'value' })).toEqual({ key: 'value' });
        });

        it('accepts empty object', () => {
            expect(MetadataJsonSchema.parse({})).toEqual({});
        });

        it('rejects non-object types', () => {
            expect(MetadataJsonSchema.safeParse('string').success).toBe(false);
            expect(MetadataJsonSchema.safeParse(123).success).toBe(false);
        });
    });

    // ─── IntegrationConfigJsonSchema ───

    describe('IntegrationConfigJsonSchema', () => {
        it('accepts config object', () => {
            const input = { webhookUrl: 'https://example.com', secret: 'abc' };
            expect(IntegrationConfigJsonSchema.parse(input)).toMatchObject(input);
        });

        it('defaults to empty object', () => {
            expect(IntegrationConfigJsonSchema.parse(undefined)).toEqual({});
        });
    });

    // ─── MappingMetadataJsonSchema ───

    describe('MappingMetadataJsonSchema', () => {
        it('accepts valid metadata with confidence', () => {
            const input = { source: 'YAML', version: '1.0', confidence: 0.95 };
            expect(MappingMetadataJsonSchema.parse(input)).toMatchObject(input);
        });

        it('accepts null', () => {
            expect(MappingMetadataJsonSchema.parse(null)).toBeNull();
        });

        it('rejects confidence > 1', () => {
            expect(MappingMetadataJsonSchema.safeParse({ confidence: 1.5 }).success).toBe(false);
        });

        it('rejects confidence < 0', () => {
            expect(MappingMetadataJsonSchema.safeParse({ confidence: -0.1 }).success).toBe(false);
        });
    });

    // ─── TaskMetadataJsonSchema ───

    describe('TaskMetadataJsonSchema', () => {
        it('accepts plain object', () => {
            expect(TaskMetadataJsonSchema.parse({ source: 'import' })).toEqual({ source: 'import' });
        });

        it('accepts null', () => {
            expect(TaskMetadataJsonSchema.parse(null)).toBeNull();
        });

        it('accepts undefined', () => {
            expect(TaskMetadataJsonSchema.parse(undefined)).toBeUndefined();
        });
    });

    // ─── OnboardingStepDataSchema ───

    describe('OnboardingStepDataSchema', () => {
        it('accepts step completion map', () => {
            const input = { framework: true, practices: false, team: true };
            expect(OnboardingStepDataSchema.parse(input)).toEqual(input);
        });

        it('defaults to empty object', () => {
            expect(OnboardingStepDataSchema.parse(undefined)).toEqual({});
        });
    });
});

// ─── Validation Helper Tests ───

describe('JSON Column Validation Helpers', () => {
    describe('validateAuditDetailsJson', () => {
        it('returns parsed data for valid input', () => {
            const input = { category: 'entity_lifecycle', entityName: 'Practice', operation: 'created' };
            expect(validateAuditDetailsJson(input)).toMatchObject(input);
        });

        it('returns undefined for undefined input', () => {
            expect(validateAuditDetailsJson(undefined)).toBeUndefined();
        });

        it('returns undefined for null input', () => {
            expect(validateAuditDetailsJson(null)).toBeUndefined();
        });

        it('throws ValidationError for invalid input', () => {
            expect(() => validateAuditDetailsJson({ badField: 'x' }))
                .toThrow(ValidationError);
        });

        it('thrown error has status 400', () => {
            try {
                validateAuditDetailsJson({ missingCategory: true });
                fail('Expected to throw');
            } catch (err) {
                expect(err).toBeInstanceOf(ValidationError);
                expect((err as ValidationError).status).toBe(400);
            }
        });
    });

    describe('validateVendorTags', () => {
        it('accepts valid tags', () => {
            expect(validateVendorTags(['soc2', 'gdpr'])).toEqual(['soc2', 'gdpr']);
        });

        it('throws ValidationError for non-array', () => {
            expect(() => validateVendorTags('not-array')).toThrow(ValidationError);
        });

        it('throws ValidationError for invalid items', () => {
            expect(() => validateVendorTags([123])).toThrow(ValidationError);
        });
    });

    describe('validateVendorCertifications', () => {
        it('accepts valid certifications', () => {
            const input = [{ name: 'ISO 27001' }];
            expect(validateVendorCertifications(input)).toMatchObject(input);
        });

        it('throws ValidationError for missing name', () => {
            expect(() => validateVendorCertifications([{}])).toThrow(ValidationError);
        });
    });

    describe('validateTaskMetadata', () => {
        it('accepts plain object', () => {
            expect(validateTaskMetadata({ key: 'val' })).toEqual({ key: 'val' });
        });

        it('passes through null', () => {
            expect(validateTaskMetadata(null)).toBeNull();
        });

        it('passes through undefined', () => {
            expect(validateTaskMetadata(undefined)).toBeUndefined();
        });

        it('throws ValidationError for non-object', () => {
            expect(() => validateTaskMetadata('string')).toThrow(ValidationError);
        });
    });

    describe('validateIntegrationConfig', () => {
        it('accepts plain object', () => {
            expect(validateIntegrationConfig({ url: 'https://x.com' })).toEqual({ url: 'https://x.com' });
        });

        it('throws ValidationError for non-object', () => {
            expect(() => validateIntegrationConfig('string')).toThrow(ValidationError);
        });
    });
});
