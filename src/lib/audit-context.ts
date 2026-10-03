/**
 * Audit Context — request-scoped context store for Prisma audit middleware.
 *
 * DESIGN NOTE: We use a simple module-level context stack instead of AsyncLocalStorage.
 * Prisma's $use middleware runs in a detached async context that loses ALS state.
 * A context stack is safe because:
 * 1. Node.js is single-threaded — no race conditions between set/get
 * 2. Context is set synchronously before the Prisma call and read synchronously
 *    within the $use middleware on the same tick
 * 3. The stack supports nesting (e.g., runInTenantContext inside withTenantDb)
 *
 * ⚠️ THE PREMISE ABOVE IS STALE AND REASON 2 IS FALSE. Read before reusing it.
 *
 * `$use` was REMOVED in Prisma 7 and the audit trail now runs as a
 * `$extends({ query })` extension. Measured 2026-10-02 in
 * `tests/integration/prisma-extension-als-reachability.test.ts`: a Prisma 7
 * query extension DOES see the AsyncLocalStorage store (an `afterCommit` call
 * from inside one is deferred to the post-commit drain rather than fired
 * inline). So "ALS does not reach the middleware" is no longer a reason to
 * prefer this stack — do not re-derive it from the paragraph above.
 *
 * And reason 2 is not how the extension is actually read. A query extension is
 * `async` and awaits `query(args)`, so reads are NOT confined to one tick, and
 * `getAuditContext()` returns the TOP of this stack — which under concurrent
 * requests is whichever request pushed LAST, not the caller. `after-commit.ts`
 * documents choosing ALS specifically to avoid that; the audit trail still
 * reads the stack and consequently misattributes rows across tenants under
 * concurrency. Measured and filed as #1259: eleven concurrent writes to eleven
 * DISTINCT tenants produced eleven audit rows all carrying ONE tenant's id.
 * `resolveTenantDekPair` reads the same context.
 *
 * This comment is a correction only — nothing here changes behaviour. The fix
 * belongs with #1259, which owns the test population for it.
 *
 * Usage:
 *   await runWithAuditContext({ tenantId, actorUserId: userId, requestId }, async () => {
 *       await prisma.evidence.create({ data: { ... } });
 *       // Middleware reads context from the stack
 *   });
 */

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
 * Context stack — supports nesting. The top of the stack is the current context.
 * Push on enter, pop on exit.
 */
const contextStack: AuditContextData[] = [];

/**
 * Checks if a value is "thenable" (has a .then method).
 * This is more robust than instanceof Promise because Prisma returns
 * PrismaPromise objects that are thenable but not instanceof Promise.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isThenable(value: any): value is PromiseLike<any> {
    return value != null && typeof value.then === 'function';
}

/**
 * Execute a function within an audit context.
 * All Prisma operations within `fn` will have access to this context
 * via getAuditContext().
 *
 * IMPORTANT: The fn should be an async function (not returning a bare PrismaPromise).
 * If you must pass a non-async function that returns a PrismaPromise,
 * wrap it: () => appPrisma.risk.create({...}).then(r => r)
 */
export function runWithAuditContext<T>(
    ctx: AuditContextData,
    fn: () => T | Promise<T>,
): T | Promise<T> {
    contextStack.push(ctx);
    try {
        const result = fn();
        // Handle both sync and async/thenable functions.
        // We check for thenable (not just Promise) because Prisma returns
        // PrismaPromise objects that are thenable but NOT instanceof Promise.
        if (isThenable(result)) {
            return new Promise<T>((resolve, reject) => {
                (result as PromiseLike<T>).then(
                    (value) => {
                        contextStack.pop();
                        resolve(value);
                    },
                    (err) => {
                        contextStack.pop();
                        reject(err);
                    },
                );
            });
        }
        contextStack.pop();
        return result;
    } catch (err) {
        contextStack.pop();
        throw err;
    }
}

/**
 * Get the current audit context, or undefined if not within a runWithAuditContext call.
 */
export function getAuditContext(): AuditContextData | undefined {
    return contextStack.length > 0 ? contextStack[contextStack.length - 1] : undefined;
}

/**
 * Set/override individual fields on the current audit context.
 * Only works if already inside a runWithAuditContext call.
 * Returns false if no context is active.
 */
export function mergeAuditContext(partial: Partial<AuditContextData>): boolean {
    if (contextStack.length === 0) return false;
    Object.assign(contextStack[contextStack.length - 1], partial);
    return true;
}
