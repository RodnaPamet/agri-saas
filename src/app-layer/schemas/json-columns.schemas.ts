/**
 * Centralized Zod Schemas for JSON Column Validation
 *
 * These schemas enforce type-safe write-time validation for all JSON columns
 * persisted to the database. They are used at usecase/service boundaries
 * before data reaches Prisma.
 *
 * Design decisions:
 * ─────────────────
 * - Schemas are permissive-by-default with `.passthrough()` to avoid rejecting
 *   existing stored data that may have extra fields. New writes are validated;
 *   existing reads are not retroactively broken.
 * - Each schema is exported both as a Zod type and as a TypeScript type.
 * - Validation helpers (`validateXxx`) return the parsed value or throw
 *   a typed ValidationError (400) with structured Zod details.
 *
 * @module app-layer/schemas/json-columns.schemas
 */
import { z } from 'zod';
import { badRequest, InternalError } from '@/lib/errors/types';

// ─── Audit Log: detailsJson ──────────────────────────────────────────
// The structured event payload for machine-readable audit entries.
// Every audit event must have a `category` discriminator.

export const AuditDetailsJsonSchema = z.object({
    /** Event category — required discriminator */
    category: z.enum([
        'entity_lifecycle',
        'data_lifecycle',
        'status_change',
        'relationship',
        'access',
        'custom',
    ]),
    /** Entity name for lifecycle events */
    entityName: z.string().optional(),
    /** CRUD operation */
    operation: z.string().optional(),
    /** Changed field names (for updates) */
    changedFields: z.array(z.string()).optional(),
    /** State before the change */
    before: z.record(z.string(), z.unknown()).optional(),
    /** State after the change */
    after: z.record(z.string(), z.unknown()).optional(),
    /** Human-readable summary */
    summary: z.string().optional(),
    /** Status change: from */
    fromStatus: z.string().nullable().optional(),
    /** Status change: to */
    toStatus: z.string().nullable().optional(),
    /** Status change: reason */
    reason: z.string().optional(),
    /** Relationship: source entity type */
    sourceEntity: z.string().optional(),
    /** Relationship: source entity ID */
    sourceId: z.string().optional(),
    /** Relationship: target entity type */
    targetEntity: z.string().optional(),
    /** Relationship: target entity ID */
    targetId: z.string().optional(),
    /** Relationship type/label */
    relation: z.string().optional(),
    /** Custom event discriminator */
    event: z.string().optional(),
    /** Free-form detail string */
    detail: z.string().optional(),
    /** Target user affected by access change */
    targetUserId: z.string().optional(),
}).passthrough();

export type AuditDetailsJson = z.infer<typeof AuditDetailsJsonSchema>;

// ─── Audit Log: metadataJson ─────────────────────────────────────────
// Free-form but must be a plain object (no arrays, no primitives at root).

export const MetadataJsonSchema = z.record(z.string(), z.unknown());

export type MetadataJson = z.infer<typeof MetadataJsonSchema>;

// ─── Vendor: tags ────────────────────────────────────────────────────
// JSON array of non-empty strings, max 50 tags, each max 100 chars.

export const VendorTagsSchema = z.array(
    z.string().min(1).max(100)
).max(50).default([]);

export type VendorTags = z.infer<typeof VendorTagsSchema>;

// ─── Vendor: certificationsJson ──────────────────────────────────────
// Array of certification objects.

export const VendorCertificationsSchema = z.array(z.object({
    name: z.string().min(1),
    issuer: z.string().optional(),
    expiresAt: z.string().optional(),
    verified: z.boolean().optional(),
}).passthrough()).default([]);

export type VendorCertifications = z.infer<typeof VendorCertificationsSchema>;

// ─── IntegrationConnection: configJson ───────────────────────────────
// Connection-specific config — validated shape depends on provider,
// so we enforce "must be a plain object" at the column level.

export const IntegrationConfigJsonSchema = z.record(z.string(), z.unknown()).default({});

export type IntegrationConfigJson = z.infer<typeof IntegrationConfigJsonSchema>;

// ─── RequirementMapping: metadataJson ────────────────────────────────
// Optional provenance/context for cross-framework mappings.

export const MappingMetadataJsonSchema = z.object({
    source: z.string().optional(),
    version: z.string().optional(),
    notes: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
}).passthrough().nullable();

export type MappingMetadataJson = z.infer<typeof MappingMetadataJsonSchema>;

// ─── Task: metadataJson ──────────────────────────────────────────────
// Optional task metadata — must be a plain object.

export const TaskMetadataJsonSchema = z.record(z.string(), z.unknown()).nullable().optional();

export type TaskMetadataJson = z.infer<typeof TaskMetadataJsonSchema>;

// ─── Onboarding: stepData ────────────────────────────────────────────
// Onboarding wizard step completion data.

export const OnboardingStepDataSchema = z.record(
    z.string(),
    z.boolean().or(z.string()).or(z.number()).or(z.null())
).default({});

export type OnboardingStepData = z.infer<typeof OnboardingStepDataSchema>;

// ─── Validation Helpers ──────────────────────────────────────────────
// These throw typed ValidationError (400) on invalid input.

/**
 * Validate and return audit detailsJson. Accepts undefined/null and returns
 * undefined to support optional fields.
 *
 * ## Throws a 500, not a 400 — #2602
 *
 * This threw `badRequest('Invalid detailsJson structure', result.error.issues)`
 * until 2026-11-01, and since #1223 the audit append runs on the CALLER's
 * transaction, so that refusal surfaced to the client as a 400 on the business
 * write. Three of them were found in a release check of «Документи» on
 * 2026-10-31: the phone fell back to its generic «Заявката съдържа невалидни
 * данни.» because the payload carried no code it knew.
 *
 * A bad `detailsJson` is OUR payload being wrong, not the caller's request.
 * The remedy — "the server is passing an invalid audit discriminator" — is not
 * a sentence any client should show a farmer, and a 400 tells them their
 * request was invalid, which is false and unactionable. `InternalError` says
 * "not your fault", which is true. It costs nothing extra: on a fail-closed
 * entity the business write aborted either way, so this changes what the
 * person is TOLD and not what survives.
 *
 * `InternalError` carries `expose: false`, so the client receives
 * `code: 'INTERNAL'` with a generic message while this one reaches the log.
 * The zod issues are NOT passed as `details`: `toApiErrorResponse` sends
 * `details` unconditionally for any `AppError`, so the old call handed the
 * caller the issue list describing this schema's own shape.
 *
 * The issue PATHS are folded into the non-exposed message instead — they name
 * our fields, never a value, and a value could carry user data. The message
 * PREFIX is unchanged deliberately: four assertions match
 * `/Invalid detailsJson structure/`, and rewording a throw to reflect a
 * changed shape is how a fix arrives looking like a regression.
 *
 * #2601 moved this validation to the type layer, which is what makes the
 * change safe: the runtime case is unreachable from TypeScript call sites and
 * stays a defensive check against anything dynamic. A defensive check against
 * our own bug is exactly what a 500 is for.
 */
export function validateAuditDetailsJson(input: unknown): AuditDetailsJson | undefined {
    if (input === undefined || input === null) return undefined;
    const result = AuditDetailsJsonSchema.safeParse(input);
    if (!result.success) {
        const where = result.error.issues
            .map((i) => i.path.join('.') || '(root)')
            .join(', ');
        throw new InternalError(`Invalid detailsJson structure at: ${where}`);
    }
    return result.data;
}

/**
 * Validate and return vendor tags, or throw 400.
 */
export function validateVendorTags(input: unknown): VendorTags {
    const result = VendorTagsSchema.safeParse(input);
    if (!result.success) {
        throw badRequest('Invalid tags: must be an array of strings (max 50, each max 100 chars)', result.error.issues);
    }
    return result.data;
}

/**
 * Validate and return vendor certifications, or throw 400.
 */
export function validateVendorCertifications(input: unknown): VendorCertifications {
    const result = VendorCertificationsSchema.safeParse(input);
    if (!result.success) {
        throw badRequest('Invalid certifications structure', result.error.issues);
    }
    return result.data;
}

/**
 * Validate and return task metadataJson, or throw 400.
 */
export function validateTaskMetadata(input: unknown): TaskMetadataJson {
    if (input === undefined || input === null) return input;
    const result = TaskMetadataJsonSchema.safeParse(input);
    if (!result.success) {
        throw badRequest('Invalid metadataJson: must be a plain object', result.error.issues);
    }
    return result.data;
}

/**
 * Validate and return integration configJson, or throw 400.
 */
export function validateIntegrationConfig(input: unknown): IntegrationConfigJson {
    const result = IntegrationConfigJsonSchema.safeParse(input);
    if (!result.success) {
        throw badRequest('Invalid configJson: must be a plain object', result.error.issues);
    }
    return result.data;
}
