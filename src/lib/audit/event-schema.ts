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

/**
 * A transition of some entity's state.
 *
 * ## `toStatus` stays REQUIRED, and six call sites were fixed instead
 *
 * Six sites emitted this category with no `toStatus` at all (#2109). Making it
 * optional was the one-line option and was rejected on the owner's ruling: a
 * category called `status_change` that cannot say what the status changed TO
 * would make the schema agree with the code by asserting less, and a reader
 * filtering on it would get rows that announce a transition without naming its
 * destination.
 *
 * So each of the six was fixed to what it actually was. Three were not status
 * changes at all and moved to `entity_lifecycle` — a draft being CREATED, a
 * handle rename, and a field edit whose `fields` array is precisely what
 * `changedFields` already declares. One (consent recording) moved to `custom`.
 * Two really were transitions and had simply named the field something else.
 *
 * ## The optional fields below are broad, deliberately
 *
 * Owner ruling: declare what the callers actually send rather than nesting it
 * under a `detail` record, which would be `.passthrough()` by the back door
 * for that subtree and would stop this category policing anything inside it.
 *
 * The cost is visible and was accepted: several of these are set by exactly
 * one caller, so this one member now documents four unrelated domains. What it
 * buys is that every field is NAMED — a typo is still rejected, which is what
 * `.strict()` is for. If this list keeps growing, the honest next step is to
 * split the category rather than to widen it again.
 */
export const StatusChangeSchema = z.object({
    category: z.literal('status_change'),
    entityName: z.string().min(1),
    fromStatus: z.string().nullable().optional(),
    toStatus: z.string().min(1),
    reason: z.string().optional(),
    /**
     * Declared because its sibling `EntityLifecycleSchema` has always had it
     * and this did not — the oversight that made 7 of the 17 non-conforming
     * sites non-conforming.
     */
    summary: z.string().optional(),
    /** The resulting state, as `entity_lifecycle` records it. */
    after: z.record(z.string(), z.unknown()).optional(),
    // ── exchange-expiry-sweep ──
    commodity: z.string().optional(),
    side: z.string().optional(),
    expiresAtIso: z.string().optional(),
    transitionedBy: z.string().optional(),
    // ── access-review execution ──
    total: z.number().int().nonnegative().optional(),
    counts: z.record(z.string(), z.unknown()).optional(),
    confirmed: z.number().int().nonnegative().optional(),
    executed: z.number().int().nonnegative().optional(),
    skipped: z.number().int().nonnegative().optional(),
    // ── public farm profile ──
    handle: z.string().optional(),
    removedHandle: z.string().optional(),
    // ── agro signals ──
    locationId: z.string().optional(),
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
    /**
     * The three `review_decision_*` verbs are #2109's: an access-review
     * decision is recorded under `access` DELIBERATELY — `access-review.ts`
     * says why, and it is not a style choice: "SIEM operators already filter
     * on it for authn/authz reviews". Re-categorising those rows would move
     * them out of the query a compliance operator runs.
     *
     * Past tense, like `session_revoked` and `permission_changed` beside them.
     * Named rather than flattened onto `permission_changed`, which is the
     * owner's standing ruling from #2164 ("name what happened rather than
     * flatten it") and is also just true here: SUBMITTED and REVOKED change no
     * permission at all — they record a reviewer's verdict — while only
     * EXECUTED actually alters a membership.
     */
    operation: z.enum([
        'login',
        'logout',
        'session_revoked',
        'permission_changed',
        'review_decision_submitted',
        'review_decision_revoked',
        'review_decision_executed',
    ]),
    targetUserId: z.string().optional(),
    ipAddress: z.string().optional(),
    detail: z.string().optional(),
    /**
     * Declared because the call sites already write them (#2109) — the same
     * reason `MembershipSchema` gained `summary`: "its sibling
     * `EntityLifecycleSchema` has always had it and this did not", which is
     * the oversight that made conforming sites non-conforming.
     *
     * `accessReviewId` and `actorIsAssignedReviewer` sit at the top level
     * rather than inside `after` because that is where the rows already carry
     * them, and `StatusChangeSchema` next door declares domain keys the same
     * way (`handle`, `locationId`, `commodity`). Moving them would change what
     * a reader of the existing 1,203 rows finds.
     */
    entityName: z.string().min(1).optional(),
    summary: z.string().optional(),
    before: z.record(z.string(), z.unknown()).optional(),
    after: z.record(z.string(), z.unknown()).optional(),
    accessReviewId: z.string().optional(),
    actorIsAssignedReviewer: z.boolean().optional(),
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
