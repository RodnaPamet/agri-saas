/**
 * The platform-support gate (#12).
 *
 * Global catalogues — `Company`, `Promotion`, and eventually `AgriEvent` — are
 * shared by every tenant, so curating them is platform work, not tenant work. A
 * tenant-facing write would let one farm edit what every other farm sees.
 *
 * The existing platform-admin primitive (`verifyPlatformApiKey`) is a shared
 * secret in a header: it takes a `NextRequest`, so it cannot gate a page, and
 * it has no user behind it, so it cannot answer "who published this ad". That
 * is fine for machine callers and wrong for recurring human work.
 *
 * This gate takes the other route: designate ONE tenant as the platform tenant
 * and let its admins curate from the normal tenant shell. Support gets real
 * logins through the existing invite flow, sessions and RBAC apply unchanged,
 * and — the reason it is worth doing — audit rows get a legitimate `tenantId`
 * AND a real `userId`, which `AuditLog` requires and the API-key path cannot
 * supply.
 *
 * ── The two-part gate ─────────────────────────────────────────────────────
 *
 * Permissions in this codebase resolve from **Role**, so ANY `admin.*` key is
 * held by the OWNER/ADMIN of EVERY tenant. On its own a permission would hand
 * every farm's owner the global promotions feed. The tenant check is what makes
 * it real:
 *
 *     requirePermission('admin.manage')   ← necessary, NOT sufficient
 *     assertPlatformSupport(ctx)          ← the actual gate
 *
 * Both are load-bearing. The permission gives the denial an audited
 * `AUTHZ_DENIED` row and keeps the route inside the Epic C.1 coverage
 * guardrail; the slug check is what stops the cross-tenant escalation.
 *
 * A dedicated `admin.global_catalogue` key was considered and rejected: every
 * Role would grant it exactly as it grants `admin.manage`, so it would add a
 * `PermissionSet` member, a `PERMISSION_SCHEMA` entry and a grant line per role
 * without adding any control the slug check doesn't already provide.
 *
 * ── Fail closed ───────────────────────────────────────────────────────────
 *
 * With `PLATFORM_TENANT_SLUG` unset, `isPlatformTenant` is false for EVERY
 * tenant, so the console is unreachable rather than universally reachable. A
 * misconfiguration must lose the feature, never open it — an env var that
 * silently grants global write access when blank is the failure mode this
 * comment exists to prevent.
 *
 * @module lib/auth/platform-support
 */
import { env } from '@/env';
import { notFound } from '@/lib/errors/types';
import { assertCanAdmin } from '@/app-layer/policies/common';
import type { RequestContext } from '@/app-layer/types';

/**
 * Is this slug the designated platform tenant?
 *
 * Returns false when the env var is unset or empty (fail closed) and when the
 * caller has no slug. Comparison is exact — slugs are already normalised
 * lowercase by the tenant-creation path.
 */
export function isPlatformTenant(tenantSlug: string | null | undefined): boolean {
    const configured = env.PLATFORM_TENANT_SLUG?.trim();
    if (!configured) return false;
    if (!tenantSlug) return false;
    return tenantSlug === configured;
}

/**
 * Gate a platform-support surface.
 *
 * Throws `notFound` rather than `forbidden` when the tenant is not the platform
 * tenant: from any other tenant's perspective this console genuinely does not
 * exist, and a 403 would confirm that a global-catalogue surface is there to be
 * found. Inside the platform tenant, a non-admin gets the normal admin denial
 * with its audit row.
 */
export function assertPlatformSupport(ctx: RequestContext): void {
    if (!isPlatformTenant(ctx.tenantSlug)) {
        throw notFound('Not found');
    }
    assertCanAdmin(ctx);
}
