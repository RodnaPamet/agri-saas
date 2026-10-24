/**
 * Data Classification Registry
 *
 * Defines which fields in the schema are PII, sensitive, or plain metadata.
 * Used by guard tests to enforce encryption compliance and by migration
 * tooling to know which fields need encrypted counterparts.
 *
 * Classification tiers:
 *   Tier 1 — APP_ENCRYPTED:  PII, encrypted at application layer (AES-256-GCM)
 *   Tier 2 — ALREADY_SECURED: Already encrypted/hashed by existing code (MFA, passwords)
 *   Tier 3 — DB_ENCRYPTED:   Sensitive business content, relies on DB/volume encryption
 *   Tier 4 — PLAIN:          Operational metadata, no encryption needed
 */

// ─── Types ──────────────────────────────────────────────────────────

export type DataTier = 'APP_ENCRYPTED' | 'ALREADY_SECURED' | 'DB_ENCRYPTED' | 'PLAIN';

export interface FieldClassification {
    /** Prisma model name */
    model: string;
    /** Field name in the model */
    field: string;
    /** Classification tier */
    tier: DataTier;
    /** Why this classification was chosen */
    reason: string;
    /** Whether a search hash column is needed for indexed lookups */
    needsSearchHash?: boolean;
}

// ─── Classification Registry ────────────────────────────────────────

/**
 * Complete classification of PII and sensitive fields.
 *
 * This registry is the single source of truth for which fields need
 * application-layer encryption. Guard tests scan this to verify
 * that encrypted columns exist in the schema for all Tier 1 fields.
 */
export const DATA_CLASSIFICATION: readonly FieldClassification[] = [
    // ─── Tier 1: App-Encrypted PII ──────────────────────────────────
    {
        model: 'User',
        field: 'email',
        tier: 'APP_ENCRYPTED',
        reason: 'Primary user PII — email identifies the person',
        needsSearchHash: true, // needed for login/lookup by email
    },
    {
        model: 'User',
        field: 'name',
        tier: 'APP_ENCRYPTED',
        reason: 'Personal name is PII under GDPR/ISO27001',
        needsSearchHash: false,
    },
    {
        model: 'NotificationOutbox',
        field: 'toEmail',
        tier: 'APP_ENCRYPTED',
        reason: 'Recipient email is PII',
        needsSearchHash: false,
    },
    {
        model: 'UserIdentityLink',
        field: 'emailAtLinkTime',
        tier: 'APP_ENCRYPTED',
        reason: 'SSO-linked email is PII',
        needsSearchHash: true,
    },

    // ─── Tier 2: Already Secured ────────────────────────────────────
    {
        model: 'User',
        field: 'passwordHash',
        tier: 'ALREADY_SECURED',
        reason: 'bcrypt hashed — no plaintext stored',
    },
    {
        model: 'UserMfaEnrollment',
        field: 'secretEncrypted',
        tier: 'ALREADY_SECURED',
        reason: 'AES-256-GCM via totp-crypto.ts',
    },
    {
        model: 'UserMfaEnrollment',
        field: 'backupCodesHashJson',
        tier: 'ALREADY_SECURED',
        reason: 'Hashed backup codes',
    },

    // ─── Tier 3: DB/Storage-Encrypted ───────────────────────────────
    {
        model: 'Evidence',
        field: 'content',
        tier: 'DB_ENCRYPTED',
        reason: 'Sensitive business content — relies on PostgreSQL TDE / volume encryption',
    },
    {
        model: 'AuditLog',
        field: 'details',
        tier: 'DB_ENCRYPTED',
        reason: 'May contain PII in audit trail — relies on DB encryption',
    },
    {
        model: 'Account',
        field: 'access_token',
        tier: 'DB_ENCRYPTED',
        reason: 'OAuth token — managed by Auth.js, relies on DB encryption',
    },
    {
        model: 'Account',
        field: 'refresh_token',
        tier: 'DB_ENCRYPTED',
        reason: 'OAuth token — managed by Auth.js, relies on DB encryption',
    },
    {
        model: 'Account',
        field: 'id_token',
        tier: 'DB_ENCRYPTED',
        reason: 'OAuth token — managed by Auth.js, relies on DB encryption',
    },
    {
        model: 'TenantIdentityProvider',
        field: 'configJson',
        tier: 'DB_ENCRYPTED',
        reason: 'IdP client secrets — should be promoted to APP_ENCRYPTED in follow-up',
    },
] as const;

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Returns the classification for a specific model+field, or undefined.
 */
export function getFieldClassification(
    model: string,
    field: string,
): FieldClassification | undefined {
    return DATA_CLASSIFICATION.find(
        (c) => c.model === model && c.field === field,
    );
}

/**
 * Returns all fields for a given model that need app-layer encryption.
 */
export function getAppEncryptedFields(model: string): FieldClassification[] {
    return DATA_CLASSIFICATION.filter(
        (c) => c.model === model && c.tier === 'APP_ENCRYPTED',
    );
}

/**
 * Returns all fields across all models that need app-layer encryption.
 */
export function getAllAppEncryptedFields(): FieldClassification[] {
    return DATA_CLASSIFICATION.filter((c) => c.tier === 'APP_ENCRYPTED');
}

/**
 * Returns all fields that need a search hash column for indexed lookups.
 */
export function getFieldsNeedingSearchHash(): FieldClassification[] {
    return DATA_CLASSIFICATION.filter(
        (c) => c.tier === 'APP_ENCRYPTED' && c.needsSearchHash,
    );
}

/**
 * Checks if a field is classified as requiring app-layer encryption.
 */
export function isFieldAppEncrypted(model: string, field: string): boolean {
    return DATA_CLASSIFICATION.some(
        (c) => c.model === model && c.field === field && c.tier === 'APP_ENCRYPTED',
    );
}

// ─── Soft-Delete Target Models ──────────────────────────────────────

/**
 * Models that should have soft-delete (deletedAt + deletedByUserId).
 *
 * Status:
 *   ✅ = already has deletedAt in schema
 *   ❌ = needs migration
 */
export const SOFT_DELETE_TARGETS = [
    { model: 'Asset',      hasDeletedAt: true,  priority: 'P0' },
    { model: 'Evidence',   hasDeletedAt: true,  priority: 'P0' },
    // `hasDeletedAt` was FALSE on both of the next two until 2026-10-24, and
    // both models have had the column all along. The flag is hand-maintained
    // while the schema is the real answer, so it went stale with nothing
    // failing — `SOFT_DELETE_MODELS` derives from the `model` names and
    // ignores this field, which is why nobody noticed.
    //
    // It is not inert: `encryption.test.ts` partitions this list by it.
    //
    // `Task` STAYS in this registry. Taking it out was tried on 2026-10-24 and
    // reverted, because the consequences are not local: `withDeleted()` throws
    // a Prisma validation error for a non-allowlisted model (the magic key is
    // only stripped for members), and 32 of 45 `db.task.*` reads rely on the
    // extension to inject `deletedAt: null` rather than naming it — so flagged
    // rows would surface in the task list and the due-notification sweep.
    // Doing it means auditing those 32 reads first. See #2242.
    { model: 'FileRecord', hasDeletedAt: true,  priority: 'P1' },
    { model: 'Task',       hasDeletedAt: true,  priority: 'P2' },
    // Grain (2026-07-25). Contract shipped with the full soft-delete
    // trio and a soft-deleting usecase but was registered nowhere, so
    // `retentionUntil` was written by nothing and read by nothing.
    //
    // THIS LIST IS THE SOURCE OF TRUTH. `SOFT_DELETE_MODELS` in
    // `src/lib/soft-delete.ts` now DERIVES from it rather than being a
    // hand-kept mirror, and `retention-purge.ts` iterates that. The GRC
    // teardown removed Practice / Policy / Vendor / Finding / Audit /
    // AuditCycle / AuditPack from here; dropping a model from this list
    // restores HARD-delete semantics for it, which is why that shipped
    // alongside the phase-3 drop rather than ahead of it.
    { model: 'Contract',   hasDeletedAt: true,  priority: 'P3' },
] as const;
