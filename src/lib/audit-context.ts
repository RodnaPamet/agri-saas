/**
 * Audit Context — request-scoped context for the Prisma audit + encryption
 * extensions.
 *
 * ## This was a module-level stack, and that was a cross-tenant defect
 *
 * Until #1259 the store was `const contextStack: AuditContextData[] = []` —
 * one array shared by every in-flight request in the process — defended by
 * this argument:
 *
 *   > Prisma's `$use` middleware runs in a detached async context that loses
 *   > ALS state. A context stack is safe because: 1. Node.js is
 *   > single-threaded — no race conditions between set/get. 2. Context is set
 *   > synchronously before the Prisma call and read synchronously within the
 *   > `$use` middleware on the same tick.
 *
 * Every clause was true when written and all of them were false by 2026-10-03:
 *
 *   - **"Single-threaded" rules out torn reads, not INTERLEAVING.** Another
 *     request pushes its context while this one is suspended at an `await`,
 *     and `getAuditContext()` then returns the wrong tenant.
 *   - **`$use` no longer exists.** Prisma 7 removed it; the live path is an
 *     async `$extends({ query })` handler that awaits, so "the same tick" is
 *     gone.
 *   - **The REASON for avoiding ALS was also obsolete** — a `$extends`
 *     handler DOES see the ALS store, measured by
 *     `tests/integration/prisma-extension-als-reachability.test.ts`.
 *
 * What made it a defect rather than a tidiness problem: `resolveTenantDekPair`
 * in `src/lib/db/encryption-middleware.ts` reads this context to choose WHICH
 * TENANT'S DEK encrypts a row. Measured on the stack — 8 concurrent writes
 * across 8 distinct tenants, cold DEK cache — **1 correct, 7 encrypted under
 * another tenant's key**, unreadable by their owners, with the per-tenant key
 * boundary that Epic B exists to enforce not holding at all.
 *
 * ## Why ALS is correct here, including when it returns nothing
 *
 * `AsyncLocalStorage` scopes the store to the async subtree that established
 * it, so interleaving cannot alias one request's context onto another's.
 *
 * It also changes the NO-CONTEXT case, in the safe direction. A Prisma call
 * with no enclosing `runWithAuditContext` used to pick up whatever happened to
 * be on top of the stack — possibly another tenant's — and encrypt under that
 * tenant's DEK, which only that tenant can read. It now gets `undefined`, so
 * `resolveTenantDekPair` returns `NO_DEK_PAIR` and the value is written under
 * the GLOBAL KEK (`v1:`). Still not what the caller intended, but recoverable:
 * the global KEK can decrypt it, and the envelope prefix makes it visible to
 * the `v1`→`v2` sweep. An unrecoverable row beats neither.
 *
 * The thenable handling the stack needed is gone with it. `als.run()`
 * propagates through the whole continuation chain via async_hooks, so there is
 * no pop to schedule and no need to special-case Prisma's thenable-but-not-
 * Promise `PrismaPromise`.
 *
 * Usage is unchanged:
 *
 *   await runWithAuditContext({ tenantId, actorUserId: userId, requestId }, async () => {
 *       await prisma.evidence.create({ data: { ... } });
 *       // the extensions read it via getAuditContext()
 *   });
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface AuditContextData {
    /** Tenant ID for the current request */
    tenantId?: string;
    /** Authenticated user ID performing the operation */
    actorUserId?: string;
    /** Request correlation ID */
    requestId?: string;
    /** Source of the operation: "api" | "job" | "seed" | "system" */
    source?: string;
}

/**
 * The store. Nesting works by construction — an inner `run` shadows the outer
 * one for its own subtree and nothing has to be unwound.
 */
const asyncLocalStorage = new AsyncLocalStorage<AuditContextData>();

/**
 * Is this thenable? More robust than `instanceof Promise`, because Prisma
 * returns `PrismaPromise` objects which are thenable but not Promises.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isThenable(value: any): value is PromiseLike<any> {
    return value != null && typeof value.then === 'function';
}

/**
 * Execute `fn` within an audit context.
 *
 * ## Why the thenable branch is load-bearing, and not stack-era residue
 *
 * `als.run()` keeps the store alive for the synchronous call and for every
 * async continuation created INSIDE it. That is not sufficient on its own,
 * because **a `PrismaPromise` is LAZY**: `prisma.asset.create(...)` builds a
 * thenable and starts no query until something calls `.then()` on it. Several
 * call sites pass a NON-async callback that hands one straight back —
 *
 *     runWithAuditContext(ctx, () => appPrisma.asset.create({ … }))
 *
 * — so returning that object out of `als.run` means the caller's `await`
 * subscribes OUTSIDE the scope, the query executes with no store, and
 * `getAuditContext()` returns undefined. The audit extension then takes its
 * `if (!tenantId) return query(args)` fast path and writes NO audit row, with
 * nothing failing. Measured: it silently cost all 7 assertions in
 * `tests/integration/audit-middleware.test.ts` on the first attempt at this
 * migration.
 *
 * Subscribing here, inside the scope, is what starts the query in context. The
 * stack era handled the same hazard by deferring its `pop` until the promise
 * settled, and warned about it in prose; this is the same requirement, met by
 * construction instead of by asking callers to remember.
 */
export function runWithAuditContext<T>(
    ctx: AuditContextData,
    fn: () => T | Promise<T>,
): T | Promise<T> {
    return asyncLocalStorage.run(ctx, () => {
        const result = fn();
        // `Promise.resolve` calls `.then` on the thenable HERE, which is what
        // makes a lazy PrismaPromise begin executing inside the store.
        return isThenable(result) ? Promise.resolve(result) : result;
    });
}

/** The current audit context, or undefined outside `runWithAuditContext`. */
export function getAuditContext(): AuditContextData | undefined {
    return asyncLocalStorage.getStore();
}

/**
 * Set/override individual fields on the current audit context.
 * Returns false if no context is active.
 *
 * This mutates the stored OBJECT, which is how it has always worked — but the
 * blast radius shrank with the store: on the stack a merge was visible to
 * every concurrent request, and it is now confined to the subtree that owns
 * the context.
 */
export function mergeAuditContext(partial: Partial<AuditContextData>): boolean {
    const store = asyncLocalStorage.getStore();
    if (!store) return false;
    Object.assign(store, partial);
    return true;
}
