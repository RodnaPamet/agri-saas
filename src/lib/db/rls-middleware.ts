/**
 * Epic A.1 — Prisma ↔ PostgreSQL RLS cooperation layer.
 *
 * This module is the canonical entry point for running Prisma queries
 * with PostgreSQL row-level-security in effect. It does three things:
 *
 *   1. Re-exports the transaction-scoped tenant-context helpers from
 *      `src/lib/db-context.ts` (`runInTenantContext`, `withTenantDb`,
 *      `runInGlobalContext`). These set `SET LOCAL ROLE app_user` and
 *      `set_config('app.tenant_id', …, true)` inside a Prisma
 *      `$transaction`, so every query inside the callback inherits
 *      the tenant context. `SET LOCAL` + `set_config(..., true)` are
 *      transaction-scoped — they auto-reset at commit/rollback and
 *      are safe under PgBouncer transaction pooling.
 *
 *   2. Provides `runWithoutRls` as the explicit, grep-able bypass
 *      path for admin / auth-discovery / webhook-ingest code. The
 *      superuser_bypass policy on every RLS-protected table permits
 *      non-`app_user` sessions, so calling the raw prisma client from
 *      inside this helper is sufficient. The helper exists for
 *      *documentation*: it makes the intent explicit at the call
 *      site instead of hiding in a bare `prisma.xxx.foo()` call.
 *
 *   3. Installs a Prisma `$use` tripwire (`installRlsTripwire`) that
 *      observes every query and logs when a tenant-scoped model is
 *      touched *without* either a tenant context or an explicit
 *      bypass marker. This is **defense in depth** — the authoritative
 *      isolation is in the database (RLS), the tripwire just makes
 *      dev-time detection louder than "empty result set".
 *
 * WHY NOT A PER-QUERY `SET LOCAL` MIDDLEWARE?
 *
 * The Epic A.1 brief suggested "before each query, SET LOCAL
 * app.current_tenant_id". A literal implementation would fail: Prisma
 * `$use` runs in the same async frame as the query it wraps, but a
 * bare `SET LOCAL` fired outside a transaction lands in its own
 * connection and doesn't affect the subsequent query. Inside a
 * transaction it works but is redundant with the transaction-level
 * set.
 *
 * The transaction-wrapper pattern is strictly superior:
 *   - One round-trip per transaction instead of N per query.
 *   - `SET LOCAL` naturally scopes to the transaction — commit/
 *     rollback resets automatically.
 *   - PgBouncer transaction-pool compatible.
 *
 * The brief's name (`app.current_tenant_id`) is also not what the
 * existing 51 policies use. We keep `app.tenant_id` for zero-churn
 * compatibility — the enforcement contract is the isolation model,
 * not the variable name.
 */

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { getAuditContext } from '@/lib/audit-context';
import { logger } from '@/lib/observability/logger';
import * as prismaModule from '@/lib/prisma';

// Same pattern as `audit-writer.ts` — `import * as prismaModule` gives
// a live namespace binding; reading `prismaModule.prisma` inside the
// function defers the dereference to call-time. That sidesteps both
// the historical TDZ hazard (prisma.ts statically imports this module
// for the tripwire extension, but only USES the runtime helpers like
// `runWithoutRls` after both modules have evaluated) AND Turbopack's
// production-build issue with dynamic TS-module `require()` returning
// `undefined`.
function getPrismaClient(): PrismaClient {
    return prismaModule.prisma as unknown as PrismaClient;
}

// ─── Re-exports: the canonical RLS API ────────────────────────────────
//
// New code should import from this module (`@/lib/db/rls-middleware`)
// rather than `@/lib/db-context`. The physical location of the
// transaction helpers is an implementation detail.

export {
    runInTenantContext,
    withTenantDb,
    runInGlobalContext,
} from '@/lib/db-context';
export type { PrismaTx } from '@/lib/db-context';

// ─── Explicit bypass helper ──────────────────────────────────────────

/**
 * Enumerated set of reasons the bypass helper may be invoked with.
 * Adding a new reason is an architectural decision — treat it as a
 * code review checkpoint, not a routine change. The runtime rejects
 * any reason not in this set.
 */
export type RlsBypassReason =
    /** NextAuth JWT callback discovering a user's tenant memberships. */
    | 'auth-tenant-discovery'
    /** Credentials lookup (password reset, invite redemption, etc.). */
    | 'auth-credentials'
    /** Inbound webhook receipt before tenant identification. */
    | 'webhook-ingest'
    /** Scheduled sweep that iterates every tenant by design. */
    | 'cross-tenant-sweep'
    /** Seed scripts (prisma/seed.ts and friends). */
    | 'seed'
    /** One-off admin / maintenance script. */
    | 'admin-script'
    /** Library import / bootstrap of global catalogue data. */
    | 'library-import'
    /** Tests exercising the bypass path itself. */
    | 'test';

/**
 * Execute a callback with the raw `prisma` client — no tenant context,
 * no `app_user` role switch.
 *
 * RLS bypass is permitted because every tenant-protected table carries
 * a `superuser_bypass` policy of the form:
 *     USING (current_setting('role') != 'app_user')
 *
 * A session running as `postgres` (which is what Prisma's default
 * connection uses) matches this policy. Callers inside this helper see
 * all rows regardless of tenant.
 *
 * Use this SPARINGLY. Every invocation:
 *   - must supply a typed `reason` from `RlsBypassReason` (compile-time
 *     allowlist); arbitrary strings are rejected.
 *   - is logged at info level with the reason and a short caller
 *     fingerprint (module path from the stack trace), so audit
 *     review can find every bypass site without a grep.
 *
 * Anything not covered by an existing reason must go through
 * `runInTenantContext` so RLS enforces, OR get a new reason added
 * here after review.
 *
 * @example
 *   await runWithoutRls(
 *     { reason: 'auth-tenant-discovery' },
 *     async (db) => db.tenantMembership.findMany({ where: { userId } })
 *   );
 */
export async function runWithoutRls<T>(
    options: { reason: RlsBypassReason },
    callback: (db: PrismaClient) => Promise<T>,
): Promise<T> {
    if (!KNOWN_REASONS.has(options.reason)) {
        throw new Error(
            `runWithoutRls called with unknown reason '${options.reason}'. ` +
                `Add the reason to RlsBypassReason in rls-middleware.ts ` +
                `after reviewing whether bypass is actually required.`
        );
    }

    logger.info('rls-middleware.bypass_invoked', {
        component: 'rls-middleware',
        reason: options.reason,
        caller: extractCallerFingerprint(new Error()),
    });

    return callback(getPrismaClient());
}

const KNOWN_REASONS: ReadonlySet<RlsBypassReason> = new Set<RlsBypassReason>([
    'auth-tenant-discovery',
    'auth-credentials',
    'webhook-ingest',
    'cross-tenant-sweep',
    'seed',
    'admin-script',
    'library-import',
    'test',
]);

/**
 * Pull the first non-middleware frame out of a stack trace so the log
 * line points at the calling usecase/script, not at this file. Returns
 * a compact `module:line` marker. Never throws.
 */
function extractCallerFingerprint(err: Error): string {
    const stack = err.stack ?? '';
    const lines = stack.split('\n').slice(1); // drop "Error"
    for (const line of lines) {
        // Skip frames in this module.
        if (line.includes('rls-middleware')) continue;
        // Typical: "    at functionName (/abs/path/file.ts:123:45)"
        const match = line.match(/\(([^)]+):(\d+):\d+\)/) ||
            line.match(/at ([^ ]+):(\d+):\d+/);
        if (!match) continue;
        const [, file, lineNum] = match;
        // Trim to last two path segments so log output is readable.
        const short = file.split('/').slice(-2).join('/');
        return `${short}:${lineNum}`;
    }
    return 'unknown';
}

// ─── Tenant-scoped model catalogue ───────────────────────────────────

/**
 * Set of model names that carry a `tenantId` column or are
 * semantically tenant-scoped via an ownership relation.
 *
 * The direct-scoped list is enumerated at startup from Prisma's DMMF
 * (introspectable datamodel) so it stays in lockstep with
 * `schema.prisma` — no manual maintenance.
 *
 * The ownership-chained list is hand-curated: those tables have no
 * `tenantId` column but are tenant-scoped via their parent(s). This
 * mirrors the RLS coverage in migration
 * `20260422180000_enable_rls_coverage`.
 */

const OWNERSHIP_CHAINED_MODELS: readonly string[] = [
    // Remaining ownership-chained tables — no `tenantId` column, RLS
    // policy walks the parent. Six ex-members of this list
    // (EvidenceReview, AuditChecklistItem, FindingEvidence,
    // AuditorPackAccess, PolicyPracticeLink, PolicyApproval) were
    // migrated to direct-tenantId by the denorm-tenantId / promote-
    // tenant migration sequences and are now picked up by
    // `enumerateDirectTenantScopedModels()`.
    'PolicyAcknowledgement',
];

function enumerateDirectTenantScopedModels(): string[] {
    return Prisma.dmmf.datamodel.models
        .filter((m) => m.fields.some((f) => f.name === 'tenantId'))
        .map((m) => m.name);
}

export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set([
    ...enumerateDirectTenantScopedModels(),
    ...OWNERSHIP_CHAINED_MODELS,
]);

/**
 * Predicate — is this Prisma model tenant-scoped (and therefore
 * RLS-protected in production)?
 */
export function isTenantScopedModel(modelName: string | undefined): boolean {
    return modelName !== undefined && TENANT_SCOPED_MODELS.has(modelName);
}

// ─── Prisma tripwire ─────────────────────────────────────────────────

/**
 * Read actions — allowed without context (empty result under RLS
 * is the fail-closed behaviour we want; the tripwire just logs).
 * Write actions — much higher signal; log at warn level because RLS
 * will reject them under app_user and the error message benefits
 * from a clear "missing context" annotation.
 */
const PRISMA_WRITE_ACTIONS = new Set([
    'create',
    'createMany',
    'update',
    'updateMany',
    'delete',
    'deleteMany',
    'upsert',
]);

/**
 * Install the dev-time RLS tripwire on the provided PrismaClient.
 *
 * Behaviour per query:
 *   - If the target model is NOT tenant-scoped: pass through.
 *   - If the target model IS tenant-scoped AND an audit context with a
 *     tenantId is active: pass through. (This is the normal
 *     `runInTenantContext` path — tenant is bound, RLS will enforce.)
 *   - If the target model IS tenant-scoped AND no tenant context is
 *     active AND the source is one of the known bypass paths
 *     ('seed', 'job', 'system'): pass through. (Those paths
 *     legitimately run without a tenant.)
 *   - Otherwise: log. `warn` for writes, `debug` for reads.
 *
 * The tripwire NEVER throws and NEVER blocks the query — the database
 * is the authoritative gate. Its purpose is *observability*: when RLS
 * returns an empty set in production because the caller forgot to
 * wrap in `runInTenantContext`, the logs point to the right file
 * immediately instead of "why is my query returning nothing".
 */
/**
 * Wire the RLS tripwire as a Prisma 7 `$extends` extension.
 *
 * Returns the extended client. The tripwire is observation-only —
 * the `$allOperations` handler reads model + operation, decides
 * whether to log a missing-tenant-context warning, then passes
 * through unchanged. It does NOT change query behaviour; the
 * authoritative isolation remains the database's RLS policies.
 *
 * Migrated from `client.$use(...)` (removed in Prisma 7). The v5
 * idempotency guard (`installedClients` WeakSet) is gone — Prisma
 * 7 extensions don't mutate the client, so calling this twice just
 * stacks two read-only handlers and the tripwire fires twice (a
 * harmless duplicate log line).
 *
 * Composition: callers in `src/lib/prisma.ts` apply this as the
 * OUTERMOST extension so the tripwire sees the original call shape
 * before soft-delete / PII rewrite the args. That way the logged
 * `model` / `action` match the caller's intent in the source.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withRlsTripwireExtension<T extends { $extends: any }>(
    client: T,
): T {
    return client.$extends({
        name: 'rls-tripwire',
        query: {
            $allModels: {
                async $allOperations({
                    model,
                    operation,
                    args,
                    query,
                }: {
                    model: string;
                    operation: string;
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    args: any;
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    query: (a: any) => Promise<any>;
                }) {
                    if (!isTenantScopedModel(model)) {
                        return query(args);
                    }

                    const ctx = getAuditContext();
                    const hasTenant = !!ctx?.tenantId;
                    const source = ctx?.source;

                    const isBypassContext =
                        source === 'seed' ||
                        source === 'job' ||
                        source === 'system';

                    if (hasTenant || isBypassContext) {
                        return query(args);
                    }

                    const isWrite = PRISMA_WRITE_ACTIONS.has(operation);
                    const logFn = isWrite ? logger.warn : logger.debug;
                    logFn('rls-middleware.missing_tenant_context', {
                        component: 'rls-middleware',
                        model,
                        action: operation,
                        hasAuditContext: !!ctx,
                        source: source ?? null,
                    });

                    return query(args);
                },
            },
        },
    }) as T;
}

/**
 * Compatibility shim — the old name kept so the existing call in
 * `src/instrumentation.ts` (which mutates the singleton) continues
 * to compile while we migrate all wiring into `src/lib/prisma.ts`.
 * This shim no-ops; the real wiring is now in the extension chain.
 *
 * @deprecated Remove once `instrumentation.ts` stops calling it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function installRlsTripwire(_client: any): void {
    /* no-op — see docstring */
}

// ─── Test-only reset ─────────────────────────────────────────────────

/**
 * @internal — kept as a no-op so existing v5 tests that called this
 * to clear the install guard still compile. Extensions don't carry
 * registration state.
 */
export function _resetTripwireInstallState(): void {
    /* no-op — see docstring */
}
