import { PrismaClient } from '@prisma/client';
import { prisma } from './prisma';
import type { RequestContext, UserContext } from '@/app-layer/types';
import { runWithAuditContext } from './audit-context';
import { runWithAuditQueue } from './db/before-commit';
import { runWithAfterCommit } from './db/after-commit';
import { logger } from '@/lib/observability/logger';
// Namespace, and read at call time — see `prewarmTenantKeys`. This module sits
// in a cycle with `@/lib/prisma`, which re-exports `withTenantDb` from here.
import * as tenantKeyManager from './security/tenant-key-manager';

export type PrismaTx = Omit<
    PrismaClient,
    '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Warm this process's tenant-DEK caches BEFORE a tenant transaction opens.
 *
 * ── the defect this exists for (#1223) ──
 *
 * `withEncryptionExtension`'s `resolveTenantDekPair` awaits
 * `getTenantDek(tenantId)` on EVERY model read and write, and
 * `tenant-key-manager` reads the `Tenant` row through the GLOBAL prisma
 * client — not through the `tx` the caller is holding. So the FIRST model
 * operation of a transaction asked the pool for a SECOND connection while
 * already holding one of its `max`. Once every slot is held by a transaction
 * in that state, none of them can get the connection it is waiting for and
 * none can release the one it has: `pg` is given no `connectionTimeoutMillis`
 * and waits indefinitely, so each transaction sits until Prisma's own 5s
 * interactive timeout fires (P2028) or its 2s `maxWait` expires.
 *
 * Measured 2026-10-01 (#1191's P0.8 sweep) and reproduced here: with a COLD
 * cache the cliff is exactly at `PG_POOL_MAX` — 11 concurrent transactions
 * are fine, 12 all fail — and a `pg_stat_activity` sample 1.5s in shows 12
 * backends `idle in transaction`, every one of them last having run
 * `SELECT set_config('app.tenant_id', $1, true)`. A WARM cache cleared 40,
 * which is the tell that the cost is one connection per tenant per process
 * rather than one per query.
 *
 * ── why pre-resolution, and why it is cheap ──
 *
 * For any transaction that touches a manifest-eligible model — which is nearly
 * all of them — this costs the same one-or-two queries it always cost; the only
 * thing that changes is that they run with NO transaction open, so they need
 * the pool's first connection rather than its second. On a warm cache both
 * calls are `Map` lookups, so the steady-state request pays nothing.
 *
 * **It is unconditional, and that is a real if small cost.** A transaction
 * whose body touches NO model — only `tx.$queryRaw`, which does not go through
 * `$allModels` — or touches only `GLOBAL_KEK_MODELS` would previously have
 * resolved no DEK at all, and on a COLD tenant now pays one or two queries it
 * used to skip. It is paid once per tenant per process and outside any
 * transaction. The alternative is to predict from outside the callback which
 * models the callback will touch, which is not knowable here; the issue (#1223)
 * named this trade for this fix shape as "changes when every request pays the
 * lookup". The alternative — teaching the extension to read the `Tenant` row
 * on the transaction's own client — needs the extension to know it is inside
 * a transaction, which the Prisma 7 query-extension API does not tell it.
 *
 * ── three properties that are load-bearing ──
 *
 * 1. **It never throws.** `resolveTenantDekPair` treats a failed lookup as
 *    "use the global KEK" and logs; it must keep being the authority on that.
 *    If this helper propagated, a `withTenantDb` for a tenant row that does
 *    not exist would start failing where it previously proceeded.
 * 2. **`previous` is only attempted when `primary` resolved**, mirroring the
 *    middleware: there, a `getTenantDek` throw returns the empty pair and
 *    `getTenantPreviousDek` is never reached.
 * 3. **Skipped when the caller injected a client.** `getTenantDek` is bound to
 *    the global singleton, so with an injected client the transaction and the
 *    DEK read sit in DIFFERENT pools and cannot deadlock each other — there is
 *    nothing to pre-resolve, and the lookup would be pure waste. It also stops
 *    the unit suites that drive these helpers against a FAKE client
 *    (`tests/unit/db-context-after-commit.test.ts`) from making a pointless
 *    connection attempt. **That second reason is cost, not correctness, and
 *    the distinction was measured rather than assumed**: removing this
 *    condition and running that suite against an unreachable database leaves
 *    it 5/5 GREEN, because property 1 swallows the connection error. So do not
 *    read the condition as the thing keeping that suite passing — it is the
 *    thing keeping it from dialling a database to no purpose.
 *
 * The namespace import above is the shape `encryption-middleware.ts` settled
 * on for this same module: `tenant-key-manager` imports `@/lib/prisma`, which
 * re-exports `withTenantDb` from this file, and reading the bindings at
 * call time keeps Turbopack's production minifier from resolving the cycle to
 * `undefined`.
 */
async function prewarmTenantKeys(tenantId: string): Promise<void> {
    try {
        await tenantKeyManager.getTenantDek(tenantId);
        await tenantKeyManager.getTenantPreviousDek(tenantId);
    } catch (err) {
        // Deliberately swallowed — property 1 above. The middleware re-attempts
        // the same lookup and owns the global-KEK fallback; all this loses is
        // the pre-warm, which turns a deadlock back into the old behaviour
        // rather than into an error.
        logger.debug('db-context.dek_prewarm_failed', {
            component: 'db-context',
            tenantId,
            reason: err instanceof Error ? err.message : 'unknown',
        });
    }
}

/**
 * Runs a function within a Prisma transaction where the Postgres session
 * variable `app.tenant_id` is set to the provided tenantId.
 * 
 * Because RLS policies are FORCED, any query reading/writing to tenant-scoped
 * tables inside this callback will automatically have its results filtered to
 * the specified tenant.
 * 
 * Also binds audit context so the Prisma middleware can correlate writes.
 * 
 * @see runInTenantContext — preferred API for usecases (accepts full RequestContext)
 */
export async function withTenantDb<T>(
    tenantId: string,
    callback: (tx: PrismaTx) => Promise<T>,
    customPrisma?: PrismaClient // used for testing to dependency-inject the client
): Promise<T> {
    const p = customPrisma || prisma;

    // #1223 — BEFORE `$transaction`, so the DEK lookup the encryption
    // extension makes on this transaction's first model operation is already a
    // cache hit and needs no second pool connection. See `prewarmTenantKeys`.
    if (!customPrisma) await prewarmTenantKeys(tenantId);

    // `runWithAfterCommit` is OUTSIDE `$transaction` deliberately: effects
    // queued with `afterCommit` inside the callback drain once this promise
    // resolves, which is after COMMIT. A nested call joins the outer scope
    // instead of draining its own — see src/lib/db/after-commit.ts.
    return runWithAfterCommit(() =>
        // Bind audit context so middleware can access tenantId
        runWithAuditContext({ tenantId, source: 'api' }, () =>
            p.$transaction(async (tx) => {
                // Drop superuser privileges to ensure RLS policies are enforced
                await tx.$executeRaw`SET LOCAL ROLE app_user`;
                // Use SET LOCAL to scope the variable to the current transaction.
                // It automatically resets when the transaction commits or rolls back.
                // $executeRaw safely parameterizes the value.
                await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
                // #1223 — the audit EXTENSION cannot reach `tx` (a query
                // handler is given no client), so it queues its rows and this
                // frame drains them onto THIS transaction before COMMIT. A
                // nested helper joins the scope and does not drain; see
                // src/lib/db/before-commit.ts.
                return runWithAuditQueue(tx, () => callback(tx));
            })
        ) as Promise<T>,
    );
}

/**
 * Preferred usecase-level helper. Accepts a full RequestContext and:
 * 1. Sets `app.tenant_id` for RLS enforcement (via withTenantDb)
 * 2. Sets `app.request_id` for log/audit correlation
 * 3. Binds full audit context (tenantId + userId + requestId) for middleware
 *
 * Usage:
 * ```ts
 * export async function listAssets(ctx: RequestContext) {
 *     return runInTenantContext(ctx, (db) => AssetRepository.list(db, ctx));
 * }
 * ```
 */
export async function runInTenantContext<T>(
    ctx: RequestContext,
    callback: (db: PrismaTx) => Promise<T>,
    options?: { customPrisma?: PrismaClient; timeout?: number; maxWait?: number }
): Promise<T> {
    const p = options?.customPrisma || prisma;
    const txOptions: { timeout?: number; maxWait?: number } = {};
    if (options?.timeout) txOptions.timeout = options.timeout;
    if (options?.maxWait) txOptions.maxWait = options.maxWait;

    // #1223 — same reason as `withTenantDb`: pre-resolve the tenant's DEK pair
    // while no transaction is open. See `prewarmTenantKeys`.
    if (!options?.customPrisma) await prewarmTenantKeys(ctx.tenantId);

    // Same placement as `withTenantDb`: the after-commit scope wraps the
    // transaction, so a usecase may queue a notification, an SSE publish or an
    // email with `afterCommit(...)` from inside the callback and have it fire
    // only once this transaction — or the outermost one enclosing it — has
    // committed. On rollback the queue is discarded unrun.
    return runWithAfterCommit(() =>
        // Bind full audit context so middleware can access tenantId, userId, requestId
        runWithAuditContext(
            {
                tenantId: ctx.tenantId,
                actorUserId: ctx.userId,
                requestId: ctx.requestId,
                source: 'api',
            },
            () =>
                p.$transaction(async (tx) => {
                    await tx.$executeRaw`SET LOCAL ROLE app_user`;
                    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${ctx.tenantId}, true)`;
                    await tx.$executeRaw`SELECT set_config('app.request_id', ${ctx.requestId}, true)`;
                    // #1298 — WHICH PERSON is asking, for policies that a
                    // tenant id cannot express. Exchange conversations are
                    // private to people now, and two members of one farm are
                    // indistinguishable to `app.tenant_id`.
                    //
                    // Deliberately a NEW variable rather than the existing
                    // `app.user_id`. That one is set only by
                    // `runInUserContext` and is read by the two-armed policy on
                    // NativeAuthCode, NativeRefreshToken, Organization,
                    // OrgMembership and UserSession:
                    //
                    //   tenantId = app.tenant_id
                    //   OR (tenantId IS NULL AND userId = app.user_id)
                    //
                    // Setting it here would open that second arm on all five
                    // inside a tenant transaction, blurring a separation whose
                    // own docblock says the separation is the point. A new name
                    // changes the evaluation of exactly zero existing policies.
                    //
                    // `withTenantDb` deliberately does NOT set this: it takes a
                    // tenantId and no ctx, so it has no person to name. With the
                    // variable unset, `current_setting(..., true)` yields NULL
                    // and the audience policy matches nothing — fail-closed, but
                    // SILENTLY, so a thread read through that helper would see
                    // zero rows rather than error. Nothing reads
                    // `ExchangeThread` / `ExchangeMessage` outside
                    // `exchange-messaging.ts` (measured), which always comes
                    // through here; `tests/guards/exchange-threads-need-an-actor.test.ts`
                    // keeps it that way.
                    await tx.$executeRaw`SELECT set_config('app.actor_user_id', ${ctx.userId}, true)`;
                    // #1223 — the audit EXTENSION cannot reach `tx` (a query
                // handler is given no client), so it queues its rows and this
                // frame drains them onto THIS transaction before COMMIT. A
                // nested helper joins the scope and does not drain; see
                // src/lib/db/before-commit.ts.
                return runWithAuditQueue(tx, () => callback(tx));
                }, txOptions)
        ) as Promise<T>,
    );
}


/**
 * Runs a callback as a PERSON: `app_user` + `app.user_id`, and no tenant.
 *
 * The counterpart to `runInTenantContext` for person-scoped surfaces. It is
 * deliberately NOT a variant of it with an optional tenant — the two set
 * different session variables and are governed by different halves of the same
 * RLS policy, and a single function with a nullable tenant would make "which
 * arm am I being judged by" a property of an argument rather than of the call.
 *
 * ── it must NEVER set `app.tenant_id`, and that is why it is a separate scope ──
 *
 * P1.4 gave user-scoped rows a two-armed policy (migration
 * `20261002080000_p1_4_user_scoped_null_tenant_rls`):
 *
 *     USING (
 *         "tenantId" = current_setting('app.tenant_id', true)::text
 *         OR ("tenantId" IS NULL AND "userId" = current_setting('app.user_id', true)::text)
 *     )
 *
 * With `app.tenant_id` unset, `current_setting(..., true)` yields NULL, the
 * first arm evaluates to NULL rather than true, and the row is judged solely by
 * the second — "this row has no tenant and it is yours". Setting a tenant here
 * would re-open the first arm and let a person-scoped query read a tenant's
 * rows, which is the exact confusion the policy was written to end.
 *
 * `SET LOCAL` scopes both the role and the variables to this transaction, so a
 * tenant value from an enclosing scope cannot leak in and nothing leaks out.
 *
 * ── the mutation the plan asks for ──
 *
 * P1's hardening list requires that removing `app.user_id` from this function
 * turns CI red. It does: with the variable unset, `current_setting` yields NULL,
 * the second arm's `"userId" = NULL` is NULL rather than true, and a user reads
 * ZERO of their own rows. `tests/integration/p1-5-user-context.test.ts` asserts
 * a non-zero count for exactly that reason — an assertion that the user sees
 * "no more than their own" would pass on an empty result and prove nothing.
 */
export async function runInUserContext<T>(
    ctx: UserContext,
    callback: (db: PrismaTx) => Promise<T>,
    options?: { customPrisma?: PrismaClient; timeout?: number; maxWait?: number },
): Promise<T> {
    const p = options?.customPrisma || prisma;
    const txOptions: { timeout?: number; maxWait?: number } = {};
    if (options?.timeout) txOptions.timeout = options.timeout;
    if (options?.maxWait) txOptions.maxWait = options.maxWait;

    // Same placement as the tenant helpers: the after-commit scope wraps the
    // transaction so queued effects drain after COMMIT.
    return runWithAfterCommit(() =>
        // No `tenantId` in the audit context either — a person-scoped write has
        // no tenant, and inventing one would misattribute it in the audit trail.
        runWithAuditContext(
            { actorUserId: ctx.userId, requestId: ctx.requestId, source: 'api' },
            () =>
                p.$transaction(async (tx) => {
                    await tx.$executeRaw`SET LOCAL ROLE app_user`;
                    await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
                    await tx.$executeRaw`SELECT set_config('app.request_id', ${ctx.requestId}, true)`;
                    // NOTE: no `app.tenant_id`. See the docblock — this is the
                    // load-bearing absence, not an omission.
                    // #1223 — the audit EXTENSION cannot reach `tx` (a query
                // handler is given no client), so it queues its rows and this
                // frame drains them onto THIS transaction before COMMIT. A
                // nested helper joins the scope and does not drain; see
                // src/lib/db/before-commit.ts.
                return runWithAuditQueue(tx, () => callback(tx));
                }, txOptions),
        ) as Promise<T>,
    );
}

/*
 * `runInGlobalContext` was deleted in P1.7.
 *
 * It took a callback and handed it the raw client. No reason, no record, no
 * constraint — "use this SAFELY and specifically for unauthenticated public
 * routes" was the whole of its contract, and nothing enforced it. Four
 * production sites used it; none was an unauthenticated public route.
 *
 * Replaced by `runWithoutRls({ reason })` in `@/lib/db/rls-middleware`, which
 * demands a reason from a closed union, rejects an unknown one at runtime, and
 * logs every invocation with a caller fingerprint so an audit can enumerate
 * the bypasses without a grep.
 *
 * That helper already existed, fully tested, with ZERO production callers —
 * a security control that was code-complete and inert while every real bypass
 * went through the untyped door beside it. `tests/guards/no-untyped-rls-bypass.test.ts`
 * is what stops the door being rebuilt.
 */
