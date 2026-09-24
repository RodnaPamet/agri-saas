/**
 * What an API key is allowed to REACH — the per-operation half of scoping.
 *
 * ## The gap this closes
 *
 * `verifyApiKey` derives a coarse role from a key's scopes: any scope ending
 * in `:write` makes the key an EDITOR, any `admin:write` makes it an ADMIN.
 * That role then populates `ctx.permissions`, and `assertCanWrite(ctx)` — the
 * gate ~250 of the 273 tenant routes actually use — reads exactly that flag.
 *
 * So before this module existed, a key scoped `tasks:write` could write
 * JOURNAL entries, field operations, parcels and insurance leads. The scope
 * named one resource and granted every one, because the only thing carried
 * forward from the scope was "this key may write something".
 *
 * `enforceApiKeyScope` was written to close that and had ZERO callers.
 * Wiring it into `requirePermission` alone would still have missed the ~250
 * routes that never call it, so the enforcement point is `getTenantCtx` —
 * the one function EVERY tenant route reaches, whichever helper it uses.
 *
 * ## Resource == path family
 *
 * The scope resource is the first path segment after `/api/t/<slug>/`. That
 * makes the vocabulary derivable from the routes rather than maintained beside
 * them, and it means a scope string says exactly what a reader thinks it says:
 * `journal:write` permits writes under `/api/t/<slug>/journal` and nothing
 * else.
 *
 * The four resources that existed before this change — `evidence`, `tasks`,
 * `reports`, `admin` — are all path families already, so every key ever
 * issued keeps the meaning it was issued with. This list is a strict superset.
 *
 * ## Fail-closed, deliberately
 *
 * A path family absent from this list cannot be named by any scope, so an API
 * key is REFUSED there. New families therefore start closed: adding
 * `/api/t/<slug>/payments` grants existing keys nothing until someone adds it
 * here on purpose. `tests/guards/api-key-scope-families.test.ts` fails when
 * the API grows past this list, so the decision is forced rather than
 * defaulted.
 */

/**
 * Every path family under `/api/t/<tenantSlug>/` a scope may name.
 *
 * Generated from the route tree, sorted, and pinned by a guard. Order is
 * alphabetical so additions produce a one-line diff.
 */
export const API_KEY_SCOPE_FAMILIES: readonly string[] = [
    'access-reviews',
    'admin',
    'agro',
    'ai',
    'assets',
    'audit-log',
    'automation',
    'billing',
    'cadastre',
    'calendar',
    'climate',
    'costs',
    'dashboard',
    'equipment',
    'evidence',
    'exchange',
    'farm-tasks',
    'field-operations',
    'files',
    'grain',
    'insurance',
    'integrations',
    'inventory',
    'issues',
    'items',
    'journal',
    'knowledge',
    'leases',
    'locations',
    'me',
    'notifications',
    'notification-settings',
    'offers',
    'onboarding',
    'planning',
    'processes',
    'push-subscriptions',
    'reports',
    'sample-data',
    'schemes',
    'search',
    'security',
    'soil',
    'sso',
    'tasks',
    'trends',
    'units',
    'users',
] as const;

const FAMILY_SET = new Set(API_KEY_SCOPE_FAMILIES);

/** The actions a scope can grant. `admin` is not one — it is a FAMILY. */
export type ScopeAction = 'read' | 'write';

/**
 * The resource an API path belongs to, or null if it is not a tenant API path.
 *
 * Returns null — rather than throwing — for anything outside `/api/t/<slug>/`,
 * because the caller uses null to mean "not a scoped surface" and decides for
 * itself. A family that exists but is not in {@link API_KEY_SCOPE_FAMILIES}
 * still returns its name, so the caller can refuse it with a message naming
 * the resource instead of a blank 403.
 */
export function scopeResourceForPath(pathname: string): string | null {
    // /api/t/<slug>/<family>/...
    const m = /^\/api\/t\/[^/]+\/([^/?#]+)/.exec(pathname);
    return m ? m[1] : null;
}

/** Is this family one a scope is allowed to name? */
export function isScopableFamily(family: string): boolean {
    return FAMILY_SET.has(family);
}

/**
 * The action an HTTP method represents.
 *
 * Anything that is not a known read is treated as a WRITE, so an unusual or
 * future method cannot slip through as a read. The default is the restrictive
 * one on purpose.
 */
export function scopeActionForMethod(method: string): ScopeAction {
    const m = method.toUpperCase();
    return m === 'GET' || m === 'HEAD' || m === 'OPTIONS' ? 'read' : 'write';
}
