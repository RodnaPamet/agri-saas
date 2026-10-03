/**
 * Which audited entities may NOT lose their audit row.
 *
 * ## Why there are two tiers at all
 *
 * `appendAuditEntry` opens its own `$transaction` on the global client, so an
 * audited write needs a SECOND pool connection. At `PG_POOL_MAX` it cannot get
 * one: measured at exactly `max` with warm DEKs and disjoint tenants, 12 writes
 * committed with 0 audit rows and 0 rejections (#1223). The write survives and
 * the hash-chained trail silently gains a hole.
 *
 * The obvious fix — write the row on the caller's transaction — is correct for
 * some entities and dangerous for others, and the dividing line is what this
 * file is. On the caller's transaction a failed insert ABORTS that transaction,
 * and until #1223 there were no SAVEPOINTs anywhere in `src/` or `prisma/` (that
 * absence was documented at `exchange-messaging.ts`, relied on at
 * `farm-profile.ts`, and
 * measured by `tests/integration/notify-transaction-abort.test.ts`). #1223 added
 * the repo's first and only one, in `audit-writer.ts`'s isolated append, which is
 * what lets the best-effort tier run on the caller's transaction at all. Before
 * it, a
 * best-effort audit on the caller's transaction would turn its COMMIT into a
 * silent ROLLBACK and destroy the business write — strictly worse than losing
 * the audit row, which is #1102/#1168 verbatim.
 *
 * Hence:
 *
 *   FAIL CLOSED  — the audit row is written on the CALLER's transaction. No
 *                  second connection, the row is atomic with the write it
 *                  describes, and a failure correctly aborts the write. For
 *                  these entities a write with no trail is the worse outcome.
 *
 *   BEST EFFORT  — everything else keeps today's behaviour: its own
 *                  transaction, its own connection, and a failure that leaves
 *                  the write standing. Still losable at `max`, but no longer
 *                  silently (see the catch in `src/lib/prisma.ts`).
 *
 * ## The rule for membership, so this list is not a matter of taste
 *
 * An entity belongs here when the audit row IS the compliance artifact rather
 * than a record about one: writes that GRANT or REVOKE access, that mint or
 * burn a CREDENTIAL, that move KEY material, or that create or destroy a
 * TENANCY. A farmer's journal entry is a record of farm work and the trail is
 * evidence about it; a role grant has no existence apart from its trail.
 *
 * Deliberately NOT here: the agronomic surface (journal, parcels, yields).
 * Those are what a regulator inspects, which argues for including them — but
 * putting a field entry behind a fail-closed audit write means an audit
 * subsystem problem stops an operator recording work in a field with no signal.
 * That trade was made consciously and is the owner's call to revisit.
 */

// Static import: `@/lib/observability/logger` reaches pino and
// `observability/context` and NOTHING that reaches `@/lib/prisma`, so this
// stays acyclic. A lazy `require()` here would be the defect of #1287.
import { logger } from '@/lib/observability/logger';

/**
 * Entity types whose audit row must be atomic with the write.
 *
 * Keyed on `AuditEventPayload.entityType`. Compared case-insensitively because
 * the codebase spells these inconsistently — `entityType: 'Location'` and
 * `entityType: 'LOCATION'` both occur — and a classification that missed a
 * casing variant would fail OPEN, which is the direction that loses rows.
 */
const FAIL_CLOSED_ENTITIES: readonly string[] = [
    // Access: who can do what
    'TenantMembership',
    'TenantCustomRole',
    'TenantInvite',
    'OrgMembership',
    'OrgInvite',
    // Credentials: minted, rotated, burnt
    'TenantApiKey',
    'TenantScimToken',
    'PasswordResetToken',
    'NativeRefreshToken',
    'UserMfaEnrollment',
    'UserSession',
    // Identity federation: who the IdP is allowed to vouch for
    'TenantIdentityProvider',
    'TenantEntraGroupMapping',
    // Security policy
    'TenantSecuritySettings',
    // Tenancy and key material (`Tenant.encryptedDek` lives here)
    'Tenant',
    'Organization',
    // The user record itself — `sessionVersion` is a mass session revocation
    'User',
];

const NORMALISED: ReadonlySet<string> = new Set(
    FAIL_CLOSED_ENTITIES.map((e) => e.toLowerCase()),
);

/** Must this entity's audit row be written on the caller's transaction? */
export function isFailClosedAuditEntity(entityType: string | null | undefined): boolean {
    if (!entityType) return false;
    return NORMALISED.has(entityType.toLowerCase());
}

/** The declared set, for tests and for anything that needs to enumerate it. */
export function failClosedAuditEntities(): readonly string[] {
    return FAIL_CLOSED_ENTITIES;
}

/**
 * Is the operator kill switch engaged?
 *
 * Read from `process.env` on EVERY call, deliberately — the same convention as
 * `AUDIT_STREAM_RETRY_ENABLED` and `AUDIT_STREAM_LEGACY_HEADERS`, so an
 * operator can flip it without a redeploy. Do not hoist it to module scope and
 * do not route it through `src/env.ts`: both would require a restart, which is
 * the one thing a switch for use mid-incident must not need.
 *
 * Only the exact string `'0'` disables. An unset, empty or misspelled value
 * leaves enforcement ON, because the safe default for an audit control is to
 * enforce, and a typo must not silently disarm it.
 */
export function failClosedEnforcementDisabled(): boolean {
    return process.env.AUDIT_FAIL_CLOSED_ENABLED === '0';
}

let degradationWarned = false;

/**
 * Must a FAILED audit row for this entity abort the caller's write?
 *
 * This is the ONE decision point, and both callers use it — the Prisma audit
 * extension (via the before-commit queue) and `logEvent`. They used to call
 * `isFailClosedAuditEntity` directly, which meant the kill switch would have
 * had to be spelled twice; two spellings of one policy is how a tier ends up
 * enforced on one path and not the other.
 *
 * `isFailClosedAuditEntity` stays PURE and keeps answering the different
 * question — "is this entity compliance-critical" — which is a property of the
 * entity and not of today's runtime configuration. Tests and enumerations want
 * that one; write paths want this one.
 *
 * ## Why the switch exists
 *
 * The tier is designed for a PER-ROW failure: one audit append fails, and a
 * membership or credential change that cannot be audited should not commit.
 * A WHOLE-SUBSYSTEM failure is a different shape — if the writer itself cannot
 * run, every tenant creation, invite and role change fails with it, and the
 * only lever is a code change and a deploy. Measured 2026-10-03: the audit
 * writer failed on 275 of 275 attempts under the E2E runtime, which took out
 * tenant creation and invite creation outright. Production was unaffected, but
 * the shape is real and an operator should not need a deploy to trade an
 * audited outage for an unaudited service.
 *
 * Degrading is a LOSS, not a fix: every row that would have aborted now
 * commits unaudited, and each one is reported by `reportLostAuditRow`. The
 * warning below fires once per process so that a switch left on is visible in
 * the logs rather than only in someone's memory of an incident.
 */
export function shouldFailClosed(entityType: string | null | undefined): boolean {
    if (!isFailClosedAuditEntity(entityType)) return false;
    if (failClosedEnforcementDisabled()) {
        if (!degradationWarned) {
            degradationWarned = true;
            try {
                logger.warn('audit.fail_closed_disabled', {
                    component: 'audit-fail-closed',
                    reason: 'AUDIT_FAIL_CLOSED_ENABLED=0',
                    effect: 'compliance-critical audit failures no longer abort the write',
                    entities: FAIL_CLOSED_ENTITIES.length,
                });
            } catch {
                /* A broken logger must not decide whether a write commits. */
            }
        }
        return false;
    }
    return true;
}

/** Test seam: the once-per-process warning would otherwise leak between tests. */
export function __resetFailClosedWarningForTests(): void {
    degradationWarned = false;
}
