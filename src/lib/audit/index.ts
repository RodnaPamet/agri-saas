/**
 * Audit Trail — Barrel Export
 *
 * Re-exports all audit trail modules for clean imports:
 *   import { AuditDetailsSchema, computeEntryHash } from '@/lib/audit';
 */

// Types & enums
export type {
    ActorType,
    AuditDetailCategory,
    AuditDetails,
    AuditEntryInput,
    AuditEntryOutput,
    EntityLifecycleDetails,
    StatusChangeDetails,
    RelationshipDetails,
    AccessDetails,
    DataLifecycleDetails,
    CustomDetails,
} from './types';

// Zod schemas for validation
export {
    AuditDetailsSchema,
    EntityLifecycleSchema,
    StatusChangeSchema,
    RelationshipSchema,
    AccessSchema,
    DataLifecycleSchema,
    CustomSchema,
} from './event-schema';
export type { AuditDetailsPayload } from './event-schema';

// Canonical hashing
export {
    computeEntryHash,
    canonicalJsonStringify,
    buildHashPayload,
    toCanonicalTimestamp,
    HASH_FIELDS,
} from './canonical-hash';
export type { HashInput } from './canonical-hash';

// Event builder — DELETED, and the absence is the point (#2109).
//
// `buildAuditEntry` validated `detailsJson` against the canonical
// `AuditDetailsSchema` and threw on a mismatch. It had ZERO call sites in
// `src` for its whole life: the real write path is `logEvent`, which parses
// with the permissive `.passthrough()` schema instead. So the strict contract
// was documented, typed, schema'd — and applied to not one real write, which
// is precisely how the two drifted to 15.9% conformance before anyone looked.
//
// A validator nobody calls is not neutral: it reads as coverage. It is gone
// rather than wired in, because wiring it would throw inside a write path that
// is best-effort for most entity types — the throw gets swallowed and the audit
// row is silently LOST, which is strictly worse than a non-canonical row.
//
// What covers this now, on the live path: `shadowParseAuditDetails` in
// `src/app-layer/events/audit.ts` parses every payload against the canonical
// schema and logs `audit.details_not_canonical` without ever throwing, and
// `tests/guards/audit-structured-events.test.ts` holds the call sites at
// 206 of 206. Do not re-add an uncalled validator; extend the shadow parse.

// Hash-chained writer
export { appendAuditEntry, verifyAuditChain } from './audit-writer';
export type { AppendAuditInput, AppendAuditResult, ChainVerificationResult } from './audit-writer';

// #1223 — which entities may not lose their audit row.
// Exported here for discoverability, but `logEvent` imports the module
// DIRECTLY: seven unit suites mock this barrel with a partial factory, and
// anything they do not list resolves to `undefined`. If you add a consumer on
// a path that runs under those tests, import the module, not the barrel.
export {
    isFailClosedAuditEntity,
    failClosedAuditEntities,
    shouldFailClosed,
    failClosedEnforcementDisabled,
} from './fail-closed-entities';
