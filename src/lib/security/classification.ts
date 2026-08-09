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
        model: 'VendorContact',
        field: 'name',
        tier: 'APP_ENCRYPTED',
        reason: 'Third-party contact name is PII',
        needsSearchHash: false,
    },
    {
        model: 'VendorContact',
        field: 'email',
        tier: 'APP_ENCRYPTED',
        reason: 'Third-party contact email is PII',
        needsSearchHash: true,
    },
    {
        model: 'VendorContact',
        field: 'phone',
        tier: 'APP_ENCRYPTED',
        reason: 'Phone number is PII',
        needsSearchHash: false,
    },
    {
        model: 'AuditorAccount',
        field: 'email',
        tier: 'APP_ENCRYPTED',
        reason: 'External auditor email is PII',
        needsSearchHash: true,
    },
    {
        model: 'AuditorAccount',
        field: 'name',
        tier: 'APP_ENCRYPTED',
        reason: 'External auditor name is PII',
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
    {
        model: 'AuditPackShare',
        field: 'tokenHash',
        tier: 'ALREADY_SECURED',
        reason: 'SHA-256 hash only — no plaintext stored',
    },

    // ─── Tier 3: DB/Storage-Encrypted ───────────────────────────────
    {
        model: 'Evidence',
        field: 'content',
        tier: 'DB_ENCRYPTED',
        reason: 'Sensitive business content — relies on PostgreSQL TDE / volume encryption',
    },
    {
        model: 'PolicyVersion',
        field: 'contentText',
        tier: 'DB_ENCRYPTED',
        reason: 'Policy content — needs full-text search, relies on DB encryption',
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
    { model: 'Control',    hasDeletedAt: true,  priority: 'P0' },
    { model: 'Evidence',   hasDeletedAt: true,  priority: 'P0' },
    { model: 'Policy',     hasDeletedAt: true,  priority: 'P0' },
    { model: 'Vendor',     hasDeletedAt: false, priority: 'P1' },
    { model: 'FileRecord', hasDeletedAt: false, priority: 'P1' },
    { model: 'Task',       hasDeletedAt: false, priority: 'P2' },
    { model: 'Finding',    hasDeletedAt: false, priority: 'P2' },
    { model: 'Audit',      hasDeletedAt: false, priority: 'P3' },
    { model: 'AuditCycle', hasDeletedAt: false, priority: 'P3' },
    { model: 'AuditPack',  hasDeletedAt: false, priority: 'P3' },
    // Grain (2026-07-25). Contract shipped with the full soft-delete
    // trio and a soft-deleting usecase but was registered nowhere, so
    // `retentionUntil` was written by nothing and read by nothing. Kept
    // in step with SOFT_DELETE_MODELS in `src/lib/soft-delete.ts` — the
    // two lists are documented as mirrors of each other.
    { model: 'Contract',   hasDeletedAt: true,  priority: 'P3' },
] as const;
