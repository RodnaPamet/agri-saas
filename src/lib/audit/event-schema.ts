/**
 * Audit Trail — Structured Event Schema (Zod Validation)
 *
 * Zod schemas for validating the canonical `detailsJson` payloads.
 * These schemas enforce the structured event contract and strip
 * unknown keys to ensure deterministic hashing.
 *
 * IMPORTANT: These schemas define the CANONICAL shape of audit payloads.
 * Any change to field names or required fields is a BREAKING CHANGE
 * that invalidates existing hash chains. Bump the `version` field
 * in AuditEntryInput when making breaking changes.
 *
 * @module audit/event-schema
 */
import { z } from 'zod';

// ─── Entity Lifecycle ───────────────────────────────────────────────

export const EntityLifecycleSchema = z.object({
    category: z.literal('entity_lifecycle'),
    entityName: z.string().min(1),
    /**
     * `upserted` is here because the code does upserts and this enum did not
     * say so — 654 of 1,203 production rows carried `operation: 'upsert'`
     * (#2109). Owner ruling: name what happened rather than flatten it to
     * `updated`, which would be actively wrong for the upserts that created
     * the row.
     *
     * The batch verbs are NOT here. `createMany` / `updateMany` / `deleteMany`
     * normalise to the singular past tense at the write path, because the
     * batch-ness is already recorded elsewhere on the entry — `entityId` is
     * the literal `'batch'` and `metadataJson.recordIds.count` carries the
     * number. A `createdmany` verb would be a second spelling of a fact the
     * row already states.
     */
    operation: z.enum(['created', 'updated', 'upserted', 'deleted', 'restored', 'purged']),
    changedFields: z.array(z.string()).optional(),
    before: z.record(z.string(), z.unknown()).optional(),
    after: z.record(z.string(), z.unknown()).optional(),
    summary: z.string().optional(),
    /**
     * Provenance, both already written by callers and both rejected by
     * `.strict()` until now (#2109): `origin` says where a record came from,
     * `operationParcelId` links a lifecycle event to its parcel. The schema
     * was behind the code rather than the code being wrong.
     */
    origin: z.string().optional(),
    operationParcelId: z.string().optional(),
}).strict();

// ─── Status Change ──────────────────────────────────────────────────

export const StatusChangeSchema = z.object({
    category: z.literal('status_change'),
    entityName: z.string().min(1),
    fromStatus: z.string().nullable(),
    toStatus: z.string().min(1),
    reason: z.string().optional(),
}).strict();

// ─── Relationship ───────────────────────────────────────────────────

export const RelationshipSchema = z.object({
    category: z.literal('relationship'),
    operation: z.enum(['linked', 'unlinked']),
    sourceEntity: z.string().min(1),
    sourceId: z.string().min(1),
    targetEntity: z.string().min(1),
    targetId: z.string().min(1),
    relation: z.string().optional(),
}).strict();

// ─── Access ─────────────────────────────────────────────────────────

export const AccessSchema = z.object({
    category: z.literal('access'),
    operation: z.enum(['login', 'logout', 'session_revoked', 'permission_changed']),
    targetUserId: z.string().optional(),
    ipAddress: z.string().optional(),
    detail: z.string().optional(),
}).strict();

// ─── Data Lifecycle ─────────────────────────────────────────────────

export const DataLifecycleSchema = z.object({
    category: z.literal('data_lifecycle'),
    operation: z.enum(['purged', 'archived', 'retention_expired', 'exported']),
    recordCount: z.number().int().nonnegative().optional(),
    model: z.string().optional(),
    reason: z.string().optional(),
    graceDays: z.number().int().positive().optional(),
}).strict();

// ─── Custom ─────────────────────────────────────────────────────────
// For domain events that don't fit other categories.
// Allows arbitrary keys but MUST have `category: 'custom'`.

export const CustomSchema = z.object({
    category: z.literal('custom'),
}).passthrough();

// ─── Membership ─────────────────────────────────────────────────────

/**
 * Access-control events on a tenant membership — #2109.
 *
 * TWO shapes reach this today and only one of them has ever run in
 * production: the owner GRANT at tenant creation (`role`, `reason`,
 * `userId`, 3 rows) and the owner TRANSFER (`fromUserId`, `toUserId` and
 * three membership ids), which has never fired. Declaring this from the
 * production survey alone would have rejected the transfer the first time
 * somebody used it — the data says what has happened, the call sites say what
 * can.
 *
 * So every field is optional and `.strict()` does the work that matters here:
 * it rejects an unknown or misspelled key. What it deliberately does NOT do is
 * require either shape to be complete, because one member cannot express
 * "these five together or those three together". If a third shape appears,
 * splitting this into a nested union is the fix rather than adding a sixth
 * optional field.
 */
export const MembershipSchema = z.object({
    category: z.literal('membership'),
    role: z.string().optional(),
    reason: z.string().optional(),
    userId: z.string().optional(),
    fromUserId: z.string().optional(),
    toUserId: z.string().optional(),
    newOwnerMembershipId: z.string().optional(),
    previousOwnerMembershipId: z.string().optional(),
    previousOwnerNewRole: z.string().optional(),
}).strict();

// ─── Tenant ─────────────────────────────────────────────────────────

/**
 * Tenant creation — #2109.
 *
 * `ownerEmail` is declared because the call site sends it, not because an
 * audit payload is a good place for an address. Worth a separate look: this
 * row is readable by anybody who can read the trail, and the owner's identity
 * is already carried by `ownerUserId`.
 */
export const TenantSchema = z.object({
    category: z.literal('tenant'),
    name: z.string().min(1),
    slug: z.string().min(1),
    ownerUserId: z.string().min(1),
    ownerEmail: z.string().optional(),
    source: z.string().optional(),
}).strict();

// ─── Content ────────────────────────────────────────────────────────

export const ContentSchema = z.object({
    category: z.literal('content'),
    entityName: z.string().min(1),
}).strict();

// ─── SCIM provisioning ──────────────────────────────────────────────

/**
 * `.passthrough()`, unlike its siblings, and the call site is why: it spreads
 * a caller-supplied object — `{ category, schemaVersion, ...details }` — so
 * its key set is open by construction. A `.strict()` member here would reject
 * the next provisioning detail somebody adds, which is the opposite of what
 * declaring it is for.
 */
export const ScimProvisioningSchema = z.object({
    category: z.literal('scim_provisioning'),
    schemaVersion: z.number().int().positive(),
}).passthrough();

// ─── Discriminated Union ────────────────────────────────────────────

/**
 * Canonical audit details schema — a discriminated union on `category`.
 *
 * Usage:
 *   const result = AuditDetailsSchema.safeParse(payload);
 *   if (result.success) { ... }
 */
export const AuditDetailsSchema = z.discriminatedUnion('category', [
    EntityLifecycleSchema,
    StatusChangeSchema,
    RelationshipSchema,
    AccessSchema,
    DataLifecycleSchema,
    CustomSchema,
    // #2109 — four categories the code emitted and this union never declared.
    // `membership` and `tenant` were visible in production; `content` and
    // `scim_provisioning` were not, because neither path has fired yet.
    MembershipSchema,
    TenantSchema,
    ContentSchema,
    ScimProvisioningSchema,
]);

export type AuditDetailsPayload = z.infer<typeof AuditDetailsSchema>;
