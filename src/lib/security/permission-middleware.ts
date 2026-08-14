/**
 * API permission middleware (Epic C — Defense-in-Depth, layer 1).
 *
 * Server-side enforcement of `PermissionSet` against route handlers, so
 * the API never trusts UI visibility or client-side guards. Composes with
 * `withApiErrorHandling` and the existing `getTenantCtx()` flow.
 *
 *   import { withApiErrorHandling } from '@/lib/errors/api';
 *   import { requirePermission } from '@/lib/security/permission-middleware';
 *
 *   export const POST = withApiErrorHandling(
 *       requirePermission('tasks.create', async (req, { params }, ctx) => {
 *           // ctx is the resolved RequestContext; permission has been verified.
 *           return NextResponse.json(await createTask(ctx, await req.json()));
 *       }),
 *   );
 *
 * Denials throw `forbidden('Permission denied')` which the surrounding
 * error wrapper converts to a 403 JSON response. The reason string is
 * kept generic so the response cannot be used to enumerate the
 * permission key namespace; the structured audit event captures the
 * actual key for security review.
 *
 * The middleware is permission-key driven, not role driven, so the same
 * helper covers built-in roles, custom roles, and (future) API-key
 * scope checks. It is the ONLY admin-authorization guard in the
 * codebase: the legacy role-tier helpers (`requireAdminCtx` and its
 * `requireWriteCtx` / `requireRoleCtx` siblings) were removed once every
 * route had migrated. The ratchet at
 * `tests/guardrails/no-legacy-admin-guard.test.ts` keeps them gone.
 */

import type { NextRequest, NextResponse } from 'next/server';
import type { PermissionSet } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';
import { getTenantCtx } from '@/app-layer/context';
import { forbidden } from '@/lib/errors/types';
import { appendAuditEntry } from '@/lib/audit';
import { logger } from '@/lib/observability/logger';

// ─── Permission key shape ───────────────────────────────────────────

/**
 * Dotted permission key derived from `PermissionSet`. Examples:
 *   - "tasks.create"
 *   - "evidence.upload"
 *   - "admin.scim"
 *
 * Compile-time exhaustive — adding a new entry to `PermissionSet`
 * automatically widens this union; misspelled keys fail to compile.
 */
export type PermissionKey = {
    [Domain in keyof PermissionSet]: PermissionSet[Domain] extends Record<string, boolean>
        ? `${Domain & string}.${keyof PermissionSet[Domain] & string}`
        : never;
}[keyof PermissionSet];

/**
 * Look up a permission flag on a resolved `appPermissions` set.
 * Returns `false` for unknown keys (fail-closed).
 */
export function hasPermission(
    appPermissions: PermissionSet,
    key: PermissionKey,
): boolean {
    const [domain, action] = key.split('.') as [
        keyof PermissionSet,
        string,
    ];
    const bag = appPermissions[domain] as Record<string, boolean> | undefined;
    return Boolean(bag && bag[action] === true);
}

// ─── Handler signature plumbing ─────────────────────────────────────

/**
 * Inner handler signature the caller writes. `requirePermission`
 * resolves the route params ONCE (awaiting the Next 16 Promise) and
 * forwards them RESOLVED, so the handler reads `params.foo` directly —
 * no `await` — and gets the already-hydrated `RequestContext` as a
 * third argument (saving a round-trip through `getTenantCtx`).
 */
export type PermissionedHandler<
    TParams extends { tenantSlug: string } = { tenantSlug: string },
    TResponse = Response | NextResponse,
> = (
    req: NextRequest,
    routeArgs: { params: TParams },
    ctx: RequestContext,
) => Promise<TResponse> | TResponse;

/**
 * The App Router handler signature `requirePermission` RETURNS — the
 * thing `withApiErrorHandling` wraps and the route exports. Next 16
 * delivers a dynamic route's `params` as a Promise, so the outer
 * signature types it `Promise<TParams>`; the wrapper awaits it once
 * before handing the resolved params to the inner `PermissionedHandler`.
 * (GAP-05: this Promise typing is what retired the `AsyncifyParams`
 * transform in `withApiErrorHandling` — the export is now Next-shaped
 * without a type bridge.)
 */
export type RouteHandler<
    TParams extends { tenantSlug: string } = { tenantSlug: string },
    TResponse = Response | NextResponse,
> = (
    req: NextRequest,
    routeArgs: { params: Promise<TParams> },
) => Promise<TResponse>;

// ─── Audit + logging ────────────────────────────────────────────────

/**
 * Emit a structured AUTHZ_DENIED audit entry. Failures here are
 * logged but never propagate to the caller — denial response must
 * always reach the client even if audit storage is unavailable.
 */
async function auditPermissionDenied(
    ctx: RequestContext,
    keys: readonly PermissionKey[],
    reqMeta: { method: string; path: string },
): Promise<void> {
    try {
        await appendAuditEntry({
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            actorType: ctx.apiKeyId ? 'API_KEY' : 'USER',
            entity: 'Permission',
            entityId: keys.join(','),
            action: 'AUTHZ_DENIED',
            details: `Permission denied for ${reqMeta.method} ${reqMeta.path}`,
            detailsJson: {
                // `access` is the canonical category for authz events
                // per the audit details schema.
                category: 'access',
                event: 'authz_denied',
                permissionKeys: keys,
                role: ctx.role,
                apiKeyId: ctx.apiKeyId ?? null,
                method: reqMeta.method,
                path: reqMeta.path,
            },
            requestId: ctx.requestId,
            metadataJson: {
                role: ctx.role,
                apiKeyId: ctx.apiKeyId ?? null,
            },
        });
    } catch (err) {
        logger.warn('audit: failed to record AUTHZ_DENIED', {
            requestId: ctx.requestId,
            tenantId: ctx.tenantId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

function safePath(req: NextRequest): string {
    try {
        return req.nextUrl.pathname;
    } catch {
        return '<unknown>';
    }
}

// ─── Public middleware ──────────────────────────────────────────────

/**
 * Strategy when more than one permission is supplied.
 *   - `'all'` (default): every key must be granted.
 *   - `'any'`: at least one key must be granted.
 */
export type PermissionMode = 'all' | 'any';

/**
 * Wrap a route handler with permission enforcement. The wrapped
 * function fits the standard App Router signature so it can be passed
 * straight to `withApiErrorHandling`.
 *
 * On denial:
 *   1. Records an AUTHZ_DENIED audit entry (best-effort).
 *   2. Throws `forbidden('Permission denied')` — surfaces as a 403
 *      with a generic message via `withApiErrorHandling`.
 *
 * @param required - One key, an array of keys, or `{ keys, mode }` for
 *                   explicit AND/OR semantics.
 * @param handler  - Route handler. Receives the resolved `RequestContext`
 *                   as its third argument so it doesn't re-fetch it.
 */
export function requirePermission<
    TParams extends { tenantSlug: string } = { tenantSlug: string },
    TResponse = Response | NextResponse,
>(
    required:
        | PermissionKey
        | readonly PermissionKey[]
        | { keys: readonly PermissionKey[]; mode?: PermissionMode },
    handler: PermissionedHandler<TParams, TResponse>,
): RouteHandler<TParams, TResponse> {
    const { keys, mode } = normaliseRequirement(required);

    return async function permissionedRoute(req, routeArgs) {
        // GAP-05: Next 16 delivers `routeArgs.params` as a Promise.
        // Resolve it ONCE here, then (a) feed the resolved params to
        // `getTenantCtx`, and (b) forward the SAME resolved params to
        // the inner handler — so handlers read `params.keyId` directly
        // without each awaiting (and without the per-route latent bug of
        // a sync read against an unresolved Promise). `await` on a plain
        // sync object (the unit-test call shape, `Promise.resolve(...)`)
        // resolves to itself, so both call shapes stay correct.
        const params = await routeArgs.params;

        // `getTenantCtx` handles auth (session or API key), tenant
        // resolution, membership check, and custom-role-aware
        // appPermissions hydration. Throws AppError on auth failure.
        const ctx = await getTenantCtx(params, req);

        const granted = checkPermissions(ctx.appPermissions, keys, mode);
        if (!granted) {
            await auditPermissionDenied(ctx, keys, {
                method: req.method,
                path: safePath(req),
            });
            throw forbidden('Permission denied');
        }

        return handler(req, { params }, ctx) as Promise<TResponse>;
    };
}

/**
 * Convenience wrapper — accept callers holding **at least one** of the
 * listed permission keys.
 * Equivalent to `requirePermission({ keys, mode: 'any' }, handler)`.
 */
export function requireAnyPermission<
    TParams extends { tenantSlug: string } = { tenantSlug: string },
    TResponse = Response | NextResponse,
>(
    keys: readonly PermissionKey[],
    handler: PermissionedHandler<TParams, TResponse>,
): RouteHandler<TParams, TResponse> {
    return requirePermission({ keys, mode: 'any' }, handler);
}

/**
 * Convenience wrapper: all-of semantics over a list of permission keys.
 * Equivalent to `requirePermission({ keys, mode: 'all' }, handler)`.
 */
export function requireAllPermissions<
    TParams extends { tenantSlug: string } = { tenantSlug: string },
    TResponse = Response | NextResponse,
>(
    keys: readonly PermissionKey[],
    handler: PermissionedHandler<TParams, TResponse>,
): RouteHandler<TParams, TResponse> {
    return requirePermission({ keys, mode: 'all' }, handler);
}

// ─── Internals ──────────────────────────────────────────────────────

function normaliseRequirement(
    required:
        | PermissionKey
        | readonly PermissionKey[]
        | { keys: readonly PermissionKey[]; mode?: PermissionMode },
): { keys: readonly PermissionKey[]; mode: PermissionMode } {
    if (typeof required === 'string') {
        return { keys: [required], mode: 'all' };
    }
    if (Array.isArray(required)) {
        if (required.length === 0) {
            // An empty list would silently grant access — fail loud at
            // boot so a misconfigured route never ships.
            throw new Error(
                'requirePermission: at least one permission key is required',
            );
        }
        return { keys: required, mode: 'all' };
    }
    const obj = required as {
        keys: readonly PermissionKey[];
        mode?: PermissionMode;
    };
    if (!obj.keys || obj.keys.length === 0) {
        throw new Error(
            'requirePermission: at least one permission key is required',
        );
    }
    return { keys: obj.keys, mode: obj.mode ?? 'all' };
}

function checkPermissions(
    appPermissions: PermissionSet,
    keys: readonly PermissionKey[],
    mode: PermissionMode,
): boolean {
    if (mode === 'any') {
        return keys.some((k) => hasPermission(appPermissions, k));
    }
    return keys.every((k) => hasPermission(appPermissions, k));
}
