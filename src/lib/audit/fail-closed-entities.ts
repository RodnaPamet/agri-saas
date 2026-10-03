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
 * and there are no SAVEPOINTs anywhere in `src/` or `prisma/` (their absence is
 * documented at `exchange-messaging.ts` and relied on at `farm-profile.ts`, and
 * measured by `tests/integration/notify-transaction-abort.test.ts`). So a
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
