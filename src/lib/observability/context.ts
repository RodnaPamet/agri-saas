/**
 * Observability Request Context — AsyncLocalStorage-based request-scoped context.
 *
 * PURPOSE: Provides implicit context propagation for observability (logging,
 * tracing, error reporting). Any code running within a request can access
 * requestId, tenantId, userId, and route without explicit argument passing.
 *
 * DESIGN NOTE: This is SEPARATE from `audit-context.ts`, which carries the
 * tenant/actor the Prisma audit + encryption extensions read. That module used
 * a module-level stack and this note used to explain why: "Prisma's `$use`
 * middleware runs in a detached async context that loses AsyncLocalStorage
 * state, so audit-context intentionally avoids ALS."
 *
 * BOTH halves of that are now false, and #1259 is what the first one cost.
 * `$use` was removed in Prisma 7 — the live path is an async
 * `$extends({ query })` handler — and a `$extends` handler DOES see the ALS
 * store (measured by
 * `tests/integration/prisma-extension-als-reachability.test.ts`). The shared
 * stack aliased one request's tenant onto another's across an `await`, and
 * since that context chooses the per-tenant DEK, 7 of 8 concurrent writes were
 * encrypted under the wrong tenant's key. `audit-context.ts` is ALS now too.
 *
 * The two modules stay separate because they carry different things: this one
 * is for logs, error reports and traces; that one is read by the extensions.
 * Do NOT re-derive "the extension cannot see ALS" from any older comment —
 * run the test.
 *
 * SAFETY: Never store secrets, tokens, or raw payloads in this context.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContextData {
    /** Unique request identifier for correlation */
    requestId: string;
    /** Tenant ID (resolved after auth) */
    tenantId?: string;
    /** Authenticated user ID */
    userId?: string;
    /** Request route pattern (e.g. /api/t/[tenantSlug]/practices) */
    route?: string;
    /** High-resolution start time for duration calculation */
    startTime: number;
}

const asyncLocalStorage = new AsyncLocalStorage<RequestContextData>();

/**
 * Execute a function within an observability request context.
 * All code within `fn` can access the context via `getRequestContext()`.
 */
export function runWithRequestContext<T>(
    data: RequestContextData,
    fn: () => T,
): T {
    return asyncLocalStorage.run(data, fn);
}

/**
 * Get the current request context, or undefined if not within a request scope.
 */
export function getRequestContext(): RequestContextData | undefined {
    return asyncLocalStorage.getStore();
}

/**
 * Convenience: get the current requestId or "unknown" if no context is active.
 */
export function getRequestId(): string {
    return asyncLocalStorage.getStore()?.requestId ?? 'unknown';
}

/**
 * Enrich the current observability context with additional fields.
 * Typically called after authentication resolves tenantId/userId.
 *
 * Returns false if no context is active (noop).
 */
export function mergeRequestContext(partial: Partial<Omit<RequestContextData, 'requestId' | 'startTime'>>): boolean {
    const store = asyncLocalStorage.getStore();
    if (!store) return false;
    Object.assign(store, partial);
    return true;
}
