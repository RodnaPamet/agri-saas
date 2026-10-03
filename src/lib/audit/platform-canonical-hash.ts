/**
 * Canonical hashing for `PlatformAuditLog`. P1.9.
 *
 * The platform sibling of `org-canonical-hash.ts`, reusing the shared
 * `canonicalJsonStringify` from `canonical-hash.ts` so all three chains agree
 * on what "the same payload" means: keys sorted, arrays ordered, `null`
 * serialised rather than omitted, no whitespace.
 *
 * ## Why a separate field list rather than one shared payload builder
 *
 * The three chains hash DIFFERENT fields, and that is the point — the chain key
 * is part of the payload. `AuditLog` hashes `tenantId`, `OrgAuditLog` hashes
 * `organizationId`, and this hashes `scope`. A shared builder would have to
 * take a union of chain keys and leave the unused ones null, which makes two
 * entries in different chains hash identically whenever their other fields
 * match. Keeping the lists separate keeps "which chain is this" inside the
 * hash.
 *
 * ## `PLATFORM_HASH_FIELDS` is a claim the tests check
 *
 * It exists so a field added to the model without being added to the payload
 * fails a test rather than silently falling outside the chain's protection —
 * the failure mode where a column is tamper-evident in appearance only.
 */
import { createHash } from 'crypto';
import { canonicalJsonStringify } from './canonical-hash';

/**
 * Every field that enters the hash, sorted as the payload sorts them.
 *
 * `id` is deliberately ABSENT: it is a cuid generated per insert, so including
 * it would make the chain unverifiable from the logical content alone and would
 * let two otherwise-identical histories differ for no reportable reason.
 * `requestId` is absent for the same reason — it is correlation metadata, not
 * part of what happened.
 */
export const PLATFORM_HASH_FIELDS = [
    'action',
    'actorType',
    'actorUserId',
    'detailsJson',
    'occurredAt',
    'previousHash',
    'scope',
    'version',
] as const;

export interface PlatformHashInput {
    /** The chain key — which platform subsystem this entry belongs to. */
    scope: string;
    actorType: string;
    actorUserId: string | null;
    action: string; // PlatformAuditAction enum value
    occurredAt: string; // ISO-8601 UTC
    detailsJson: unknown;
    previousHash: string | null;
    version: number;
}

export function buildPlatformHashPayload(input: PlatformHashInput): Record<string, unknown> {
    return {
        action: input.action,
        actorType: input.actorType,
        actorUserId: input.actorUserId,
        // `?? null` so an explicit null and an omitted field hash identically —
        // the two call shapes are the same event.
        detailsJson: input.detailsJson ?? null,
        occurredAt: input.occurredAt,
        previousHash: input.previousHash,
        scope: input.scope,
        version: input.version,
    };
}

/** SHA-256 of the canonical payload. Lowercase hex, 64 chars. */
export function computePlatformEntryHash(input: PlatformHashInput): string {
    const canonical = canonicalJsonStringify(buildPlatformHashPayload(input));
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
