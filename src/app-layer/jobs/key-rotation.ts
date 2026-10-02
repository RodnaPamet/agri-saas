/**
 * Epic B.3 — Per-tenant key rotation executor.
 *
 * Rotates one tenant's key material forward onto the currently-
 * primary `DATA_ENCRYPTION_KEY`. Two concrete side-effects:
 *
 *   1. **Re-wrap the tenant DEK.** `Tenant.encryptedDek` holds the
 *      tenant's 32-byte DEK wrapped under the KEK. After a master-
 *      KEK rotation the DEK is still valid — we just need to re-wrap
 *      it under the new KEK so the row stays readable once
 *      `DATA_ENCRYPTION_KEY_PREVIOUS` is retired.
 *
 *   2. **Re-encrypt v1 ciphertexts.** Any field in `ENCRYPTED_FIELDS`
 *      that still holds a `v1:` envelope was written under the
 *      global KEK (either pre-B.2, or via a bypass source). Those
 *      values need to round-trip through the dual-KEK decrypt +
 *      primary-KEK encrypt so a future operator can remove the
 *      previous-key env var without losing access.
 *
 *      v2 ciphertexts are out of scope — they're wrapped under the
 *      tenant DEK, not the master KEK, so master rotation leaves
 *      them untouched.
 *
 * ## Zero-downtime guarantee
 *
 * - `decryptField` transparently falls back to the previous KEK
 *   during rotation, so readers keep working on rows we haven't
 *   processed yet.
 * - `encryptField` always uses the current primary KEK, so new
 *   writes land under the new key regardless of job progress.
 * - Every UPDATE is single-row. Mid-rotation crash leaves partial
 *   progress intact; re-running the job picks up from wherever the
 *   SELECT cursor stops finding v1 rows belonging to this tenant.
 *
 * ## Idempotency
 *
 * - DEK re-wrap is a no-op if the DEK is already wrapped under the
 *   primary KEK (we can't cheaply detect this; every re-run pays
 *   one re-wrap per tenant — acceptable, it's one row).
 * - v1 re-encrypt is gated by `WHERE "field" LIKE 'v1:%'`. **That does NOT
 *   skip rows processed in a prior run**, which this comment used to claim.
 *   `encryptField` emits a `v1:` envelope, so a re-encrypted value is still
 *   `v1:` and the predicate matches it again on every run. Re-running is
 *   harmless (same plaintext, fresh IV) but it is not a no-op, and "zero v1
 *   rows remain" — the condition the runbook names for retiring
 *   `DATA_ENCRYPTION_KEY_PREVIOUS` — is a count that never reaches zero.
 *   `isV1UnderPrimaryKey` (`@/lib/security/encryption`) is the predicate that
 *   does answer it; `app-layer/usecases/global-key-rotation.ts` uses it and
 *   exposes the remaining count through `GET /api/admin/key-rotation`.
 *
 * ## What this job does NOT do
 *
 *   - **The GLOBAL-key columns.** This job iterates `ENCRYPTED_FIELDS` and
 *     does `if (!hasTenantId) continue`, so two populations are invisible to
 *     it: models without a `tenantId` (`User`, `Account`), and the ENTIRE PII
 *     manifest (`PII_FIELD_MAP` in `pii-middleware.ts` — `User`,
 *     `UserIdentityLink`, `NotificationOutbox`, `Account`), which is a second
 *     encryption manifest this file has never referenced. Measured on
 *     production 2026-10-02: this job could re-encrypt **0** values while
 *     **40** `v1:` values sat in the PII manifest, including six OAuth access
 *     tokens and six refresh tokens. `app-layer/usecases/global-key-rotation.ts`
 *     covers the union; run it alongside this one or `_PREVIOUS` can never be
 *     retired.
 *   - **Resolve `@map`'d names.** It interpolates `ENCRYPTED_FIELDS` names
 *     straight into raw SQL, and those are PRISMA FIELD names, not columns.
 *     It survives only because the single `@map`'d encrypted field today
 *     (`PromotionLead.requestMessage` -> column `message`) sits on a model with
 *     no `tenantId` and is skipped for an unrelated reason. `@map` one on a
 *     tenant-scoped model and the next rotation throws 42703 mid-sweep. Held by
 *     `tests/guards/encrypted-manifests-resolve-to-columns.test.ts`.
 *
 *   - Tenant-DEK rotation (generating a new per-tenant DEK and
 *     re-encrypting every v2 ciphertext). That's a separate
 *     higher-privilege operation that requires a dedicated schema
 *     column to hold both old and new wrapped DEKs atomically.
 *     See `rotateTenantDek` in `src/lib/security/tenant-key-manager.ts`
 *     — stubbed today with a runbook-carrying error, pending real
 *     implementation. The `previousEncryptedDek` schema column this
 *     stub reserves is now in place.
 *   - Master-key material distribution. The operator still sets
 *     `DATA_ENCRYPTION_KEY` / `DATA_ENCRYPTION_KEY_PREVIOUS`
 *     outside the application.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import {
    encryptField,
    decryptField,
} from '@/lib/security/encryption';
import {
    unwrapDek,
    wrapDek,
    isWrappedDek,
} from '@/lib/security/tenant-keys';
import { clearTenantDekCache } from '@/lib/security/tenant-key-manager';
import { ENCRYPTED_FIELDS } from '@/lib/security/encrypted-fields';
import { appendAuditEntry } from '@/lib/audit/audit-writer';

// ─── Types ──────────────────────────────────────────────────────────

export interface KeyRotationOptions {
    tenantId: string;
    initiatedByUserId: string;
    requestId?: string;
    /** Override SELECT batch size per (model, field). Default 500. */
    batchSize?: number;
}

export interface KeyRotationPerFieldResult {
    model: string;
    field: string;
    scanned: number;
    rewritten: number;
    errors: number;
}

export interface KeyRotationResult {
    tenantId: string;
    dekRewrapped: boolean;
    dekRewrapError?: string;
    perField: KeyRotationPerFieldResult[];
    totalScanned: number;
    totalRewritten: number;
    totalErrors: number;
    durationMs: number;
    jobRunId: string;
}

// ─── Safety helpers ─────────────────────────────────────────────────

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(name: string, kind: string): void {
    if (!IDENT_RE.test(name)) {
        throw new Error(
            `key-rotation: invalid ${kind} identifier: ${JSON.stringify(name)}`,
        );
    }
}

// ─── DEK re-wrap ────────────────────────────────────────────────────

/**
 * Re-wrap this tenant's DEK under the current primary KEK. Idempotent
 * in outcome (the unwrapped DEK bytes are identical; only the wrap
 * changes) but we always perform the work — we can't cheaply check
 * "is this already under the primary KEK?" without decrypting with
 * the current primary, which we're doing anyway.
 *
 * Also invalidates the tenant-key-manager cache for this tenant so
 * subsequent requests re-unwrap fresh under the new KEK.
 */
async function rewrapTenantDek(tenantId: string): Promise<{
    ok: boolean;
    error?: string;
}> {
    const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { encryptedDek: true },
    });
    if (!tenant) {
        return { ok: false, error: 'tenant not found' };
    }
    if (!tenant.encryptedDek) {
        // No DEK yet — handled by tenant-key-manager's lazy-init path.
        // Not our concern.
        return { ok: true };
    }
    if (!isWrappedDek(tenant.encryptedDek)) {
        return { ok: false, error: 'encryptedDek is not a valid wrapped DEK' };
    }

    try {
        // Dual-KEK decrypt handles the rotation: if the DEK was wrapped
        // under the OLD KEK and primary is NEW, the fallback inside
        // `decryptField` unwraps successfully.
        const dek = unwrapDek(tenant.encryptedDek);
        const rewrapped = wrapDek(dek);
        await prisma.tenant.update({
            where: { id: tenantId },
            data: { encryptedDek: rewrapped },
        });
        // Drop the cached raw DEK so future requests re-unwrap under
        // the new KEK. (The raw bytes are identical, so functionally
        // the cache is already correct — but clearing keeps the
        // invariant "cached DEK came from the latest wrap" true,
        // which simplifies future rotation debugging.)
        clearTenantDekCache(tenantId);
        return { ok: true };
    } catch (err) {
        return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

// ─── v1 ciphertext re-encrypt ───────────────────────────────────────

async function rewriteV1Field(
    tenantId: string,
    model: string,
    field: string,
    batchSize: number,
): Promise<KeyRotationPerFieldResult> {
    assertIdentifier(model, 'model');
    assertIdentifier(field, 'field');

    const out: KeyRotationPerFieldResult = {
        model,
        field,
        scanned: 0,
        rewritten: 0,
        errors: 0,
    };

    // Read raw SQL — bypass the encryption middleware so we see the
    // actual v1 ciphertext (not a decrypted plaintext from the
    // middleware's read path).
    const selectSql = `
        SELECT id, "${field}" AS value
        FROM "${model}"
        WHERE "tenantId" = $1
          AND "${field}" IS NOT NULL
          AND "${field}" LIKE 'v1:%'
        ORDER BY id
        LIMIT $2
    `;

    while (true) {
        let rows: Array<{ id: string; value: string }>;
        try {
            rows = await prisma.$queryRawUnsafe<
                Array<{ id: string; value: string }>
            >(selectSql, tenantId, batchSize);
        } catch (err) {
            logger.error('key-rotation.select_failed', {
                component: 'key-rotation',
                tenantId,
                model,
                field,
                error: err instanceof Error ? err.message : String(err),
            });
            out.errors++;
            return out;
        }

        if (rows.length === 0) break;
        out.scanned += rows.length;

        for (const row of rows) {
            let plaintext: string;
            try {
                // Dual-KEK decrypt — handles both keys.
                plaintext = decryptField(row.value);
            } catch (err) {
                out.errors++;
                logger.error('key-rotation.decrypt_failed', {
                    component: 'key-rotation',
                    tenantId,
                    model,
                    field,
                    id: row.id,
                    error: err instanceof Error ? err.message : 'unknown',
                });
                continue;
            }

            let fresh: string;
            try {
                // Always under the current primary KEK.
                fresh = encryptField(plaintext);
            } catch (err) {
                out.errors++;
                logger.error('key-rotation.encrypt_failed', {
                    component: 'key-rotation',
                    tenantId,
                    model,
                    field,
                    id: row.id,
                    error: err instanceof Error ? err.message : 'unknown',
                });
                continue;
            }

            try {
                await prisma.$executeRawUnsafe(
                    `UPDATE "${model}" SET "${field}" = $1 WHERE id = $2`,
                    fresh,
                    row.id,
                );
                out.rewritten++;
            } catch (err) {
                out.errors++;
                logger.error('key-rotation.update_failed', {
                    component: 'key-rotation',
                    tenantId,
                    model,
                    field,
                    id: row.id,
                    error: err instanceof Error ? err.message : 'unknown',
                });
            }
        }

        if (rows.length < batchSize) break;
    }

    return out;
}

// ─── Public entry point ─────────────────────────────────────────────

/**
 * Run the full rotation for one tenant. Structured as:
 *   1. Audit-log "started" event.
 *   2. Re-wrap Tenant.encryptedDek.
 *   3. For each (model, field) in the manifest that has a tenantId
 *      column, re-encrypt v1 ciphertexts.
 *   4. Audit-log "completed" event with summary.
 */
export async function runKeyRotation(
    options: KeyRotationOptions,
): Promise<KeyRotationResult> {
    return runJob(
        'key-rotation',
        async () => {
            const jobRunId = crypto.randomUUID();
            const started = Date.now();
            const batchSize = Math.max(1, options.batchSize ?? 500);

            await appendAuditEntry({
                tenantId: options.tenantId,
                userId: options.initiatedByUserId,
                actorType: 'SYSTEM',
                entity: 'TenantKey',
                entityId: options.tenantId,
                action: 'KEY_ROTATION_STARTED',
                details: null,
                metadataJson: { jobRunId },
                requestId: options.requestId ?? null,
            });

            // 1. DEK re-wrap.
            const dekOutcome = await rewrapTenantDek(options.tenantId);

            // 2. v1 re-encrypt per (model, field) that carries tenantId.
            //    The manifest doesn't expose which models have a
            //    tenantId column, so we probe each manifest model
            //    once via `modelHasTenantIdColumn`. Models without
            //    one are skipped — the encrypted content on those
            //    rows can only be reached via a parent-walking
            //    rotation, which is currently out of scope (no
            //    ownership-chained model in the manifest after the
            //    denorm-tenantId Phase 1–3 sequence landed
            //    EvidenceReview + AuditChecklistItem with a direct
            //    tenantId).
            const perField: KeyRotationPerFieldResult[] = [];
            let totalScanned = 0;
            let totalRewritten = 0;
            let totalErrors = dekOutcome.ok ? 0 : 1;

            for (const [model, fields] of Object.entries(ENCRYPTED_FIELDS)) {
                // Probe — does this model have a tenantId column? We
                // infer from the Prisma model by attempting a small
                // COUNT(*). Cheaper than walking DMMF; the probe
                // result is cached per (model) for the job's life.
                const hasTenantId = await modelHasTenantIdColumn(model);
                if (!hasTenantId) continue;

                for (const field of fields) {
                    const result = await rewriteV1Field(
                        options.tenantId,
                        model,
                        field,
                        batchSize,
                    );
                    perField.push(result);
                    totalScanned += result.scanned;
                    totalRewritten += result.rewritten;
                    totalErrors += result.errors;
                }
            }

            const durationMs = Date.now() - started;

            await appendAuditEntry({
                tenantId: options.tenantId,
                userId: options.initiatedByUserId,
                actorType: 'SYSTEM',
                entity: 'TenantKey',
                entityId: options.tenantId,
                action: 'KEY_ROTATION_COMPLETED',
                details: null,
                metadataJson: {
                    jobRunId,
                    dekRewrapped: dekOutcome.ok,
                    dekRewrapError: dekOutcome.error,
                    totalScanned,
                    totalRewritten,
                    totalErrors,
                    durationMs,
                },
                requestId: options.requestId ?? null,
            });

            logger.info('key-rotation.complete', {
                component: 'key-rotation',
                tenantId: options.tenantId,
                jobRunId,
                dekRewrapped: dekOutcome.ok,
                totalScanned,
                totalRewritten,
                totalErrors,
                durationMs,
            });

            return {
                tenantId: options.tenantId,
                dekRewrapped: dekOutcome.ok,
                dekRewrapError: dekOutcome.error,
                perField,
                totalScanned,
                totalRewritten,
                totalErrors,
                durationMs,
                jobRunId,
            };
        },
        { tenantId: options.tenantId },
    );
}

// ─── Helpers ────────────────────────────────────────────────────────

const _modelHasTenantIdCache = new Map<string, boolean>();

async function modelHasTenantIdColumn(model: string): Promise<boolean> {
    assertIdentifier(model, 'model');
    const cached = _modelHasTenantIdCache.get(model);
    if (cached !== undefined) return cached;
    try {
        await prisma.$queryRawUnsafe(
            `SELECT "tenantId" FROM "${model}" LIMIT 0`,
        );
        _modelHasTenantIdCache.set(model, true);
        return true;
    } catch (err) {
        // UndefinedColumn — no tenantId on this model.
        const isColumnMissing =
            err instanceof Prisma.PrismaClientKnownRequestError ||
            (err instanceof Error && /column.*does not exist/i.test(err.message));
        _modelHasTenantIdCache.set(model, false);
        if (!isColumnMissing) {
            logger.warn('key-rotation.model_probe_failed', {
                component: 'key-rotation',
                model,
                error: err instanceof Error ? err.message : String(err),
            });
        }
        return false;
    }
}

/** @internal — expose for tests that need to reset cross-run state. */
export function _resetKeyRotationForTests(): void {
    _modelHasTenantIdCache.clear();
}
