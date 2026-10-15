/**
 * Audit Redaction — strips sensitive fields from audit log payloads.
 *
 * This module ensures that secrets, tokens, passwords, and large blobs
 * are NEVER stored in plaintext in AuditLog entries.
 *
 * Usage:
 *   const safe = redactSensitiveFields(params.args.data);
 *   // safe object has secret values replaced with "[REDACTED]"
 */

import { createHash } from 'crypto';

// ─── Sensitive field patterns (case-insensitive match) ───
const SENSITIVE_PATTERNS = [
    /password/i,
    /secret/i,
    /token/i,
    /apiKey/i,
    /api_key/i,
    /credential/i,
    /authorization/i,
    /cookie/i,
    /access_token/i,
    /accessToken/i,
    /refresh_token/i,
    /refreshToken/i,
    /private_key/i,
    /privateKey/i,
    /encryption/i,
    /hash$/i,        // passwordHash, tokenHash, etc.
    // Any column holding ciphertext. The module already INTENDED to cover
    // these — `secretEncrypted`, `accessTokenEncrypted`,
    // `refreshTokenEncrypted` and `auditStreamSecretEncrypted` were all
    // redacted before this line existed, but only by the accident of their
    // names containing `secret` or `token`. The three `*Encrypted` columns
    // whose names do NOT contain one were written to the audit row verbatim:
    // `Tenant.encryptedDek`, `Tenant.previousEncryptedDek` and
    // `NotificationOutbox.toEmailEncrypted`.
    //
    // MEASURED: a `Tenant.update` touching `encryptedDek` under an audit
    // context stored the wrapped DEK in BOTH `diffJson.after` and
    // `detailsJson.after`. It would then leave the server, because
    // `AuditLogRepository.list` does a `findMany` with no `select`, so
    // `GET /api/t/{slug}/audit-log` returns every column to any caller past
    // `assertCanAudit` — AUDITOR as well as ADMIN, and an AUDITOR is a
    // read-only role that is explicitly not a key holder.
    //
    // AND THE SECOND NUMBER, which is what right-sizes this: **0 of 1045**
    // production audit rows carry any of the three columns (counted
    // 2026-10-15 with the owner's authorisation). The reason is structural,
    // not luck — `DIFF_ACTIONS` is `['update', 'upsert']`, and every real
    // writer of these columns uses `updateMany` or `create`:
    // `tenant-key-manager.ts` backfills with `updateMany` and rotates with
    // `updateMany`, so no `after` snapshot is ever built. The leak needs a
    // plain `update` or `upsert` on a ciphertext column, which no current
    // path performs.
    //
    // So this is hardening ahead of a refactor, not an incident, and no
    // remediation of existing rows is needed. Worth keeping precisely
    // because the thing standing between the DEK and the audit log is one
    // `updateMany` that a future change has every reason to make a plain
    // `update`.
    //
    // Redacting costs the trail nothing: `changedFields` still records that
    // the column changed, and the value was opaque to every reader without
    // the KEK anyway. The one thing to watch is a future BOOLEAN named
    // `isEncrypted`, which this would redact pointlessly; there is no such
    // column in the schema today (measured across all 910 field names).
    /encrypted/i,
    /^salt$/i,
    /^ssn$/i,
    // ── AI prompt/response fields (feat/ai-guardrails) ──
    // Never store the raw prompt/response/messages of an AI call in an
    // audit row — only the promptHash. These are ANCHORED so they DON'T
    // match `promptHash` (which is safe to store + is the correlation key).
    /^prompt$/i,
    /^rawPrompt$/i,
    /^response$/i,
    /^rawResponse$/i,
    /^completionText$/i,
    /^messages$/i,
];

// ─── Large blob field patterns (content that should be summarized, not stored) ───
const BLOB_PATTERNS = [
    /contentText/i,
    /bodyHtml/i,
    /rawContent/i,
    /fileContent/i,
    /base64/i,
    /binaryData/i,
];

/** Maximum string length before treating as a blob */
const BLOB_SIZE_THRESHOLD = 2048;

const REDACTED = '[REDACTED]';

/**
 * Check if a field name matches any sensitive pattern.
 */
export function isSensitiveField(fieldName: string): boolean {
    return SENSITIVE_PATTERNS.some((pattern) => pattern.test(fieldName));
}

/**
 * Check if a field name matches a blob pattern.
 */
export function isBlobField(fieldName: string): boolean {
    return BLOB_PATTERNS.some((pattern) => pattern.test(fieldName));
}

/**
 * Summarize a large blob value: returns length + SHA256 hash prefix.
 */
function summarizeBlob(value: string): string {
    const hash = createHash('sha256').update(value).digest('hex').substring(0, 12);
    return `[BLOB len=${value.length} sha256=${hash}...]`;
}

/**
 * Redact sensitive fields from a data object.
 * Returns a new object with sensitive values replaced and blobs summarized.
 *
 * - Sensitive fields → "[REDACTED]"
 * - Large strings (>2KB) or blob fields → "[BLOB len=N sha256=abc...]"
 * - Nested objects are processed recursively (max depth 3)
 * - Arrays are NOT expanded (replaced with count summary)
 * - null/undefined values are preserved as-is
 */
export function redactSensitiveFields(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: Record<string, any> | null | undefined,
    depth: number = 0,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> | null {
    if (data == null) return null;
    if (typeof data !== 'object') return null;
    if (depth > 3) return { _truncated: true };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: Record<string, any> = {};

    for (const [key, value] of Object.entries(data)) {
        // Skip Prisma internal fields
        if (key.startsWith('_')) continue;

        // Sensitive field → redact entirely
        if (isSensitiveField(key)) {
            result[key] = REDACTED;
            continue;
        }

        // Null/undefined → preserve
        if (value == null) {
            result[key] = value;
            continue;
        }

        // String values
        if (typeof value === 'string') {
            if (isBlobField(key) || value.length > BLOB_SIZE_THRESHOLD) {
                result[key] = summarizeBlob(value);
            } else {
                result[key] = value;
            }
            continue;
        }

        // Arrays → summarize, don't expand (could be huge)
        if (Array.isArray(value)) {
            result[key] = `[Array len=${value.length}]`;
            continue;
        }

        // Dates
        if (value instanceof Date) {
            result[key] = value.toISOString();
            continue;
        }

        // Nested objects → recurse
        if (typeof value === 'object') {
            result[key] = redactSensitiveFields(value, depth + 1);
            continue;
        }

        // Primitives (number, boolean)
        result[key] = value;
    }

    return result;
}

/**
 * Extract the list of changed field names from a Prisma update data object.
 * Filters out Prisma operator wrappers (set, increment, etc.) and returns
 * just the field names.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractChangedFields(data: Record<string, any> | null | undefined): string[] {
    if (data == null) return [];
    return Object.keys(data).filter((key) => !key.startsWith('_'));
}
