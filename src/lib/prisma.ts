import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '@/env';
import { getAuditContext } from './audit-context';
import { redactSensitiveFields, extractChangedFields } from './audit-redact';
import { withSoftDeleteExtension } from './soft-delete';
import { withPiiEncryptionExtension } from './security/pii-middleware';
import { withEncryptionExtension } from './db/encryption-middleware';
import { withRlsTripwireExtension } from './db/rls-middleware';
import { PG_POOL_MAX } from './db/pool-config';
import { logger as auditMiddlewareLogger } from '@/lib/observability/logger';
import { recordAuditWriteFailure } from '@/lib/observability/metrics';
/**
 * The chain writer, as a STATIC namespace import with the dereference deferred
 * to call time.
 *
 * This file and `audit/audit-writer.ts` are a runtime cycle: audit-writer does
 * `import * as prismaModule from '../prisma'` and reads `prismaModule.prisma`
 * inside a function, for exactly this reason. Its ARCHITECTURE NOTE records
 * why, having been bitten by `require('../prisma').prisma` returning
 * `undefined` in a production bundle.
 *
 * The same fix was never applied to THIS edge. `require('./audit/audit-writer')`
 * here returned a module whose `appendAuditEntry` was `undefined` in the
 * `next build --webpack` production bundle, so the audit extension threw
 * `s is not a function` on every audited write and #1269's catch logged and
 * swallowed it. Measured on green main `e1acca2c5`, one E2E shard: 275 failed
 * audit writes across 28 models and NOT ONE success. The extension writes the
 * SYSTEM-actor half of a hash-chained trail, and it was writing nothing.
 *
 * `import * as` gives a live namespace binding, and reading the property when
 * the handler runs happens long after both modules have evaluated — so the
 * cycle is never dereferenced at module-init time. Do not "simplify" this to a
 * named import (it would be dereferenced at init, inside the cycle) and do not
 * put it back to `require()`.
 */
import * as auditWriterModule from './audit/audit-writer';

// ─── Write actions to intercept ───
const WRITE_ACTIONS = new Set([
    'create',
    'createMany',
    'update',
    'updateMany',
    'delete',
    'deleteMany',
    'upsert',
]);

// Actions that have before/after diff potential
const DIFF_ACTIONS = new Set(['update', 'upsert']);

// ─── Models to exclude from audit logging ───
const EXCLUDED_MODELS = new Set([
    'AuditLog', // Prevent infinite recursion
]);

/**
 * Simple cuid-like ID generator for audit log entries.
 */

/**
 * Build diff JSON for update/upsert operations.
 *
 * Strategy (pragmatic):
 * - Extract changedFields from params.args.data keys
 * - Extract redacted "after" values from the operation result
 * - Optionally include "before" snapshot for single-record updates
 *   (only if we can fetch it cheaply via the where clause)
 *
 * LIMITATION: We do NOT fetch "before" from the DB because:
 * 1. It would add latency to every update
 * 2. The record might already be changed by the time we read it
 * 3. For multi-tenant RLS contexts, a separate query might fail
 * Instead we capture changedFields + after snapshot.
 */
function buildDiffJson(
    action: string,
    data: Record<string, unknown> | null | undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- result is the raw Prisma return value; its shape is model-specific and unknown at the middleware layer
    result: any,
): Record<string, unknown> | null {
    if (!DIFF_ACTIONS.has(action) || !data) return null;

    const changedFields = extractChangedFields(data);
    if (changedFields.length === 0) return null;

    // Build redacted "after" snapshot from result, limited to changed fields
    const afterRaw: Record<string, unknown> = {};
    for (const field of changedFields) {
        if (result && field in result) {
            afterRaw[field] = result[field];
        }
    }

    const after = redactSensitiveFields(afterRaw);

    return {
        changedFields,
        after,
    };
}

/**
 * Audit-trail extension factory.
 *
 * Returns a Prisma 7 client extension that intercepts every WRITE
 * action ($allModels.create/update/upsert/delete/createMany/
 * updateMany/deleteMany) and writes a hash-chained AuditLog row
 * AFTER the operation completes. Best-effort — never breaks the
 * original write if audit logging itself fails.
 *
 * This was a `$use` middleware in Prisma 5; `$use` was removed in
 * Prisma 7. The new shape composes via `client.$extends({ query })`
 * with per-action handlers.
 *
 * Composition order MATTERS: this extension runs INSIDE soft-delete
 * + PII encryption + field-level encryption. Audit sees the final
 * transformed args (delete → update from soft-delete; encrypted
 * values from PII / field encryption) and logs them post-write.
 *
 * MUST only be wired in Node.js runtime (not Edge) — `appendAuditEntry`
 * pulls in heavy server deps. The wiring at module bottom guards
 * with `typeof EdgeRuntime === 'undefined'`.
 */
function buildAuditExtension() {
    // Per-action wrapper — same shape for create/update/upsert/delete/etc.
    // The Prisma 7 query extension API has separate handlers for each
    // operation; we factor the common audit logic into one function.
    const handle = async ({
        model,
        operation,
        args,
        query,
    }: {
        model: string;
        operation: string;
        args: Record<string, unknown>;
        query: (a: typeof args) => Promise<unknown>;
    }) => {
        // Fast-path non-write operations and excluded models. Reads
        // don't need audit; AuditLog itself must skip to avoid an
        // infinite write loop.
        if (!WRITE_ACTIONS.has(operation)) {
            return query(args);
        }
        if (EXCLUDED_MODELS.has(model)) {
            return query(args);
        }

        // ⚠️ Capture audit context BEFORE running the query —
        // Prisma's underlying execution may detach from the AsyncLocalStorage
        // chain.
        const ctx = getAuditContext();
        const tenantId = ctx?.tenantId;
        if (!tenantId) {
            return query(args);
        }

        const actorUserId = ctx?.actorUserId || null;
        const requestId = ctx?.requestId || null;
        const source = ctx?.source || 'api';

        // For upsert, the update payload is in args.update, not args.data.
        // `args` is typed as `object` by the Prisma query-extension API —
        // casting to a narrowed record shape is the correct probe pattern.
        const argsRecord = args as Record<string, unknown>;
        const updateData =
            operation === 'upsert'
                ? (argsRecord.update as Record<string, unknown> | null | undefined) ?? null
                : (argsRecord.data as Record<string, unknown> | null | undefined) ?? null;

        // Execute the original operation first — never block it
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- query() returns the Prisma result whose shape depends on the model/operation; narrowing it generically is impossible without generated overloads
        const result: any = await query(args);

        // Best-effort audit logging — never throw
        try {
            const action = operation.toUpperCase();

            // Extract record ID(s) from the result
            let entityId = 'unknown';
            let recordIds: { count: number } | null = null;

            if (
                operation === 'create' ||
                operation === 'update' ||
                operation === 'upsert' ||
                operation === 'delete'
            ) {
                entityId = result?.id || 'unknown';
            } else if (operation === 'createMany') {
                entityId = 'batch';
                recordIds = { count: result?.count ?? 0 };
            } else if (operation === 'updateMany' || operation === 'deleteMany') {
                entityId = 'batch';
                recordIds = { count: result?.count ?? 0 };
            }

            const metadataJson: Record<string, unknown> = { source };
            const argsWhere = argsRecord.where as Record<string, unknown> | null | undefined;
            if (
                argsWhere &&
                (operation === 'updateMany' || operation === 'deleteMany')
            ) {
                metadataJson.filterKeys = Object.keys(argsWhere);
            }

            const diffJson = buildDiffJson(operation, updateData, result);

            const detailsJson: Record<string, unknown> = {
                category: 'entity_lifecycle',
                entityName: model,
                operation: action.toLowerCase(),
            };
            if (diffJson) {
                detailsJson.changedFields = diffJson.changedFields;
                detailsJson.after = diffJson.after;
            }
            detailsJson.summary = `${action} ${model}${entityId !== 'unknown' ? ` ${entityId}` : ''}`;

            await auditWriterModule.appendAuditEntry({
                tenantId,
                userId: actorUserId,
                actorType: 'SYSTEM',
                entity: model,
                entityId,
                action,
                details: null,
                requestId,
                recordIds,
                metadataJson,
                diffJson,
                detailsJson,
            });
        } catch (auditError) {
            // #1223 — the business write has ALREADY COMMITTED by the time we
            // get here (`query(args)` resolved above), so this catch is what
            // keeps an audit-subsystem failure from taking a succeeded write
            // down with it. That contract is deliberate and it stays. What
            // changes is that the gap is no longer INVISIBLE.
            //
            // This used to log only under `NODE_ENV === 'development'`, which
            // meant that in PRODUCTION a lost hash-chained audit row produced
            // no log, no metric, no error and no trace. Measured at
            // `PG_POOL_MAX` concurrency: 12 writes committed, 0 audit rows,
            // 0 rejections — the trail had a hole and nothing said so. A
            // silent gap in a hash-chained trail is worse than a loud one,
            // because the chain's whole value is that gaps are detectable.
            //
            // NOTHING in here may throw. A failure to REPORT the lost row must
            // not become a failure of a write that already succeeded — that
            // would turn an observability change into a behaviour change,
            // which is the one thing this must not do. Each reporter is
            // guarded separately so a broken logger does not also cost the
            // metric.
            //
            // Scope note: `action` and `entityId` are declared INSIDE the try
            // and are not available here; `operation` is a handler parameter,
            // so the verb is still recoverable. `diffJson.after` holds the
            // changed row and `metadataJson` is caller-supplied, so neither
            // goes into a log line.
            try {
                auditMiddlewareLogger.error('audit.write_failed', {
                    component: 'audit-middleware',
                    tenantId,
                    requestId,
                    model,
                    operation,
                    error:
                        auditError instanceof Error
                            ? auditError.message
                            : String(auditError),
                });
            } catch {
                // A broken logger must not break a committed write.
            }
            try {
                recordAuditWriteFailure({ model, action: operation.toUpperCase() });
            } catch {
                // A broken meter must not break a committed write.
            }
        }

        return result;
    };

    return {
        name: 'audit-middleware',
        query: {
            $allModels: {
                async create({ model, operation, args, query }: { model: string; operation: string; args: Record<string, unknown>; query: (a: typeof args) => Promise<unknown> }) {
                    return handle({ model, operation, args, query });
                },
                async createMany({ model, operation, args, query }: { model: string; operation: string; args: Record<string, unknown>; query: (a: typeof args) => Promise<unknown> }) {
                    return handle({ model, operation, args, query });
                },
                async update({ model, operation, args, query }: { model: string; operation: string; args: Record<string, unknown>; query: (a: typeof args) => Promise<unknown> }) {
                    return handle({ model, operation, args, query });
                },
                async updateMany({ model, operation, args, query }: { model: string; operation: string; args: Record<string, unknown>; query: (a: typeof args) => Promise<unknown> }) {
                    return handle({ model, operation, args, query });
                },
                async upsert({ model, operation, args, query }: { model: string; operation: string; args: Record<string, unknown>; query: (a: typeof args) => Promise<unknown> }) {
                    return handle({ model, operation, args, query });
                },
                async delete({ model, operation, args, query }: { model: string; operation: string; args: Record<string, unknown>; query: (a: typeof args) => Promise<unknown> }) {
                    return handle({ model, operation, args, query });
                },
                async deleteMany({ model, operation, args, query }: { model: string; operation: string; args: Record<string, unknown>; query: (a: typeof args) => Promise<unknown> }) {
                    return handle({ model, operation, args, query });
                },
            },
        },
    } as const;
}

// ─── Singleton ───
//
// Prisma 7 — `PrismaClient` requires an adapter for connections.
// The runtime adapter is `@prisma/adapter-pg` which speaks to
// Postgres directly. CLI tooling (prisma migrate / generate /
// studio) reads the URL via `prisma.config.ts` at the repo root.
//
// Middleware moved from `prisma.$use(...)` (removed in Prisma 7) to
// `client.$extends({ query: { ... } })`. Composition order is
// preserved from the v5 layout — `$extends` chains apply in
// reverse-call order: the LAST `.$extends(...)` is the OUTERMOST
// wrapper (intercepts caller first). To match the v5 order
// (PII outermost → soft-delete → audit innermost), the chain is:
//
//     baseClient
//       .$extends(audit)        // innermost — closest to DB
//       .$extends(softDelete)   // middle — delete → update transform
//       .$extends(piiEncryption) // outermost — first to see args
//
// The Epic A.1 RLS tripwire and Epic B field-level encryption work
// on per-transaction clients inside `runInTenantContext` (in
// `src/lib/db/rls-middleware.ts` + `src/lib/db/encryption-middleware.ts`)
// — they re-extend the inner transactional client, NOT this
// singleton.

type ExtendedClient = ReturnType<typeof buildClient>;

function buildClient(): PrismaClient {
    // `??  ''` is load-bearing for build-time analysis. Next 16's
    // "Collecting page data" phase imports every route module to
    // discover route metadata, which transitively loads this module.
    // In that environment `SKIP_ENV_VALIDATION=1` is set but
    // `DATABASE_URL` is often unset — passing `undefined` to
    // `PrismaPg`'s `connectionString` throws ("p is not a function"
    // in the minified chunk) and the whole route fails to collect.
    // Falling back to an empty string lets module load succeed; the
    // first real query will surface the missing-URL error at request
    // time, not module-import time.
    const adapter = new PrismaPg({
        connectionString: env.DATABASE_URL ?? '',
        // EXPLICIT, because the alternative was `pg`'s default of 10 — a
        // ceiling nobody chose and no file records. `connection_limit` in the
        // URL would not do it: with a driver adapter the pool is `pg`'s and
        // that parameter is read by nobody. The derivation (pgbouncer's 25
        // transaction-mode server connections, two pooled containers, one slot
        // reserved) lives in `./db/pool-config` and is re-checked against
        // `deploy/docker-compose.vm.yml` by a guard.
        max: PG_POOL_MAX,
    });
    return new PrismaClient({ adapter });
}

function buildExtended() {
    const base = buildClient();
    if (typeof EdgeRuntime !== 'undefined') {
        // Edge Runtime — extensions either don't bundle or import
        // server-only deps (audit-writer pulls in node:crypto). Ship
        // the bare client; reads/writes won't have audit/PII logic
        // but Edge code paths don't perform writes that need them.
        return base as unknown as ReturnType<typeof base.$extends>;
    }
    // `withRlsTripwireExtension` is now imported statically at the
    // top of this file. The "circular import" comment that lived
    // here previously was only theoretical — `rls-middleware.ts`
    // only references `@/lib/prisma` from inside a function body
    // (`getPrismaClient()` for `runWithoutRls`), so there is no
    // module-init cycle. Turbopack's production bundle didn't
    // resolve the dynamic `require('./db/rls-middleware')` correctly
    // during Next 16's "Collecting page data" phase ("p is not a
    // function") which made the static form load-bearing.
    //
    // Composition order — the tripwire is observation-only so its
    // position in the chain is irrelevant; placing it outermost
    // makes the logged model/action match the caller's intent
    // before soft-delete / PII rewrite.
    // Composition note: Epic B field-level encryption sits between
    // soft-delete (which rewrites delete → update) and PII (GAP-21,
    // which encrypts User/AuditorAccount email/name). Inner-to-outer:
    //   audit → soft-delete → field-encryption → PII → RLS-tripwire
    // Field-encryption needs to see the post-soft-delete write args
    // (so encrypt happens on the rewritten update payload) but BEFORE
    // PII rewrites where-clauses, since the two cover disjoint
    // models. The Prisma 7 migration introduced field-encryption as a
    // separate `withEncryptionExtension` but never wired it back into
    // the chain — restoring it here restores Epic B's at-rest
    // contract.
    return withRlsTripwireExtension(
        withPiiEncryptionExtension(
            withEncryptionExtension(
                withSoftDeleteExtension(
                    base.$extends(buildAuditExtension()),
                ),
            ),
        ),
    );
}

const globalForPrisma = globalThis as unknown as {
    prisma?: ExtendedClient;
};

export const prisma = (globalForPrisma.prisma ?? buildExtended()) as ExtendedClient;

if (env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

// Diagnostic — log once per process that the extended client is
// constructed. Pairs with the per-invocation logging inside
// pii-middleware.ts to distinguish:
//   • both seen           → extension works
//   • constructed, no inv. → adapter is on a different prisma instance
//   • no constructed log  → Edge Runtime path skipped extension wiring
if (typeof EdgeRuntime === 'undefined') {
    auditMiddlewareLogger.info('pii.middleware_registered', {
        component: 'pii-middleware',
        runtime: 'node',
        nodeEnv: env.NODE_ENV,
    });
}

/**
 * Explicit global export for admin operations / scripts that need
 * to bypass RLS by running without a tenant context.
 */
export function getPrisma() {
    return prisma;
}

export { withTenantDb } from './db-context';

export default prisma;
