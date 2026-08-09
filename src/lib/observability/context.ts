/**
 * Observability Request Context — AsyncLocalStorage-based request-scoped context.
 *
 * PURPOSE: Provides implicit context propagation for observability (logging,
 * tracing, error reporting). Any code running within a request can access
 * requestId, tenantId, userId, and route without explicit argument passing.
 *
 * DESIGN NOTE: This is SEPARATE from `audit-context.ts` which uses a
 * module-level stack. Prisma's `$use` middleware runs in a detached async
 * context that loses AsyncLocalStorage state, so audit-context intentionally
 * avoids ALS. This module handles everything else: logs, error reports, traces.
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
