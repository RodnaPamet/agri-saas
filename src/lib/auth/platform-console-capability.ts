/**
 * Is the platform-support console actually reachable? (#1669)
 *
 * ## The silence this reports
 *
 * `assertPlatformSupport` is fail-closed by design, and `platform-support.ts`
 * says why: *"With `PLATFORM_TENANT_SLUG` unset, `isPlatformTenant` is false
 * for EVERY tenant, so the console is unreachable rather than universally
 * reachable. A misconfiguration must lose the feature, never open it."*
 *
 * That direction is right. The gap is that **losing the feature produces no
 * signal**, so "deliberately closed" and "never configured" look identical from
 * outside — and on the `agrent` VM they have been identical since #12 merged.
 * Probed 2026-10-12: `PLATFORM_TENANT_SLUG` is ABSENT, so every route behind
 * the gate (`admin/promotions`, `admin/promotions/[id]/image`,
 * `admin/companies/[id]`, `admin/market-prices`) has never been reachable in
 * production. The global catalogues could only ever be changed by direct
 * database access.
 *
 * This is the #781 treatment, third instance of the same argument: WATCHED, not
 * gated. `capabilities.basemap` exists because "the code shipped" and "the
 * capability is active" are different claims; so does `capabilities.email`,
 * after a mail transport silently discarded invites. Same shape here.
 *
 * ## Four states, and the fourth is the one that stops a false alarm
 *
 *   - `unconfigured` — no slug. The common, legitimate state for a self-hosted
 *     deployment, which has no platform tenant and wants none.
 *   - `misconfigured` — a slug that names no live tenant. **A typo'd slug fails
 *     exactly like an absent one through the gate**, which is the specific
 *     thing an operator cannot currently tell apart.
 *   - `reachable` — the slug resolves to a live tenant.
 *   - `unknown` — the lookup could not run. Reported rather than collapsed into
 *     `misconfigured`, because during a database incident every probe would
 *     otherwise shout about a configuration problem that does not exist. A
 *     finding wants both questions asked: this one guards against the false
 *     alarm as well as the miss, and the real signal in that window is the
 *     database check, which `readyz` already fails on.
 *
 * ## It checks something the GATE does not
 *
 * `isPlatformTenant` compares slugs and nothing else, so a SOFT-DELETED
 * platform tenant still opens the gate while being invisible to every other
 * consumer (`tenant: { deletedAt: null }` is filtered everywhere else — #1389).
 * This reports `misconfigured` for that, deliberately: an operator reading
 * `reachable` should be able to trust that the console works, and a console
 * whose tenant has been removed does not.
 *
 * ## The client is INJECTED, and not for testability
 *
 * Importing `@/lib/prisma` here would pull the extended client into
 * `readyz`'s module graph, and that module reads `Prisma.dmmf` at load. Three
 * existing readyz suites mock `@prisma/client` with `PrismaClient` alone, so
 * the import throws `Cannot read properties of undefined (reading 'dmmf')`
 * before any test runs — measured, 28 failures across 3 suites. The repo's
 * partial-barrel-mock trap, reached through a transitive import.
 *
 * `readyz` already constructs its own raw `PrismaClient` for the database
 * check, so it passes that. The raw client is also the RIGHT one: `slug` and
 * `deletedAt` are not encrypted columns, so the extension's per-tenant DEK
 * resolution would be work this does not need.
 *
 * ## Never the slug itself
 *
 * A closed enum, like `basemap`'s branch and `email`'s provider. The slug is
 * not a credential, but the precedent in this file's siblings is firm — "never
 * a key, never a host" — and a tenant slug is a URL segment somebody could
 * probe. The operator who needs the value already has the env.
 */
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';

export type PlatformConsoleState =
    | 'unconfigured'
    | 'misconfigured'
    | 'reachable'
    | 'unknown';

export interface PlatformConsoleCapability {
    readonly state: PlatformConsoleState;
}

/**
 * NOT memoized, unlike `basemapBranchStatus`.
 *
 * That one memoizes because it scans ~560 chunk files once at ~90ms. This is a
 * single `findUnique` on `Tenant.slug`, which is `@unique` and therefore an
 * index hit — and it has to stay current, because the state can change WITHOUT
 * a restart: deleting the platform tenant moves `reachable` → `misconfigured`
 * while the process keeps running. A cached `reachable` would then be a stale
 * reassurance, which is worse than no report at all.
 *
 * `readyz` is probed every 60s from six regions, so this costs ~6 indexed
 * lookups a minute.
 */
/** The one query this needs, so a caller can pass any client that has it. */
export interface TenantSlugReader {
    tenant: {
        findUnique(args: {
            where: { slug: string };
            select: { id: true; deletedAt: true };
        }): Promise<{ id: string; deletedAt: Date | null } | null>;
    };
}

export async function platformConsoleCapability(
    db: TenantSlugReader,
): Promise<PlatformConsoleCapability> {
    const slug = env.PLATFORM_TENANT_SLUG?.trim();
    if (!slug) return { state: 'unconfigured' };

    try {
        const tenant = await db.tenant.findUnique({
            where: { slug },
            select: { id: true, deletedAt: true },
        });
        // A soft-deleted tenant is NOT reachable, even though the gate's slug
        // comparison would still admit it. See the docblock.
        if (!tenant || tenant.deletedAt) return { state: 'misconfigured' };
        return { state: 'reachable' };
    } catch (err) {
        // `unknown`, never `misconfigured` — see the docblock. The slug is not
        // logged: the error is about reachability, and an operator reading a
        // log line does not need the value they configured.
        logger.warn('platform_console.capability_lookup_failed', {
            component: 'platform-console-capability',
            error: err instanceof Error ? err.message : String(err),
        });
        return { state: 'unknown' };
    }
}
