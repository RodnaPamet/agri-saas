/**
 * The farms a person belongs to — the switcher list (P3.6, agrent-ios).
 *
 * ## Why this reads the global client
 *
 * The question is "which farms are mine", so there is no tenant to scope to —
 * that IS the answer being computed. And `runInUserContext` would not help:
 * `TenantMembership`'s only policies are `tenant_isolation` (keyed on
 * `app.tenant_id`), its INSERT twin, and `superuser_bypass`. There is no
 * person clause, so a read with no tenant bound returns **zero rows, silently**
 * — the RLS silent-zero shape, which would make an empty switcher
 * indistinguishable from a person with no farms.
 *
 * What stands in for RLS here is that `userId` comes from the session and
 * never from the request, so a caller can only ever enumerate their own
 * memberships. `src/app/tenants/page.tsx` queries this same shape directly for
 * the same reason; this is that query, moved somewhere an API route can reach.
 *
 * ## The predicate is three clauses and all three matter
 *
 *   status: 'ACTIVE'            — a deactivated member is not a member
 *   tenant: { deletedAt: null } — a REMOVED farm must not appear
 *   orderBy createdAt asc       — so `farms[0]` is the oldest, matching `/me`
 *
 * The middle one is the easy miss, and the spec this was requested against did
 * not mention it. Soft-deleting a tenant sets only `Tenant.deletedAt` and
 * deliberately leaves memberships ACTIVE (the data is retained for compliance
 * and a possible restore), so a removed farm still has live memberships
 * pointing at it. Without the clause the switcher would offer farms that 404
 * at the tenant resolver.
 *
 * The ordering exists so a client can reconcile this list with the single farm
 * `/api/auth/me` names. That only holds because #1389 gave `/me` the same
 * `deletedAt` predicate — before it, `/me` could name a removed farm that this
 * list correctly omits, and `farms[0]` and `/me.tenant` would disagree exactly
 * when it mattered.
 *
 * ## No JWT claims
 *
 * Deliberately not read from `session.user.memberships`: that list is capped at
 * `MAX_JWT_MEMBERSHIPS` for cookie-size safety. A switcher that silently
 * dropped a farm past the cap would be worse than no switcher, because the
 * person would have no way to discover the omission.
 */
import prisma from '@/lib/prisma';
import type { Role } from '@prisma/client';
import { isPlatformTenant } from '@/lib/auth/platform-support';

export interface MyFarm {
    id: string;
    slug: string;
    name: string;
    role: Role;
    /**
     * Is this the designated platform farm? (#1587 contract v1.1 (e))
     *
     * A client offers Админ → «Цени» when the OPEN farm's row has
     * `isPlatform: true` and its `role` is `OWNER` or `ADMIN`.
     *
     * ## Why the flag is here and not on `/api/auth/me`
     *
     * v1 of the contract put `isPlatformAdmin` on `/api/auth/me`, and agrent-ios
     * caught that it would have been FALSE for the owner exactly when it
     * mattered. `/api/auth/me` has no tenant in its path, so "the" tenant is
     * resolved as `orderBy: { createdAt: 'asc' }, take: 1` — the user's OLDEST
     * active membership. The flag would therefore have been evaluated against
     * the owner's first farm while they had the new platform farm open. The web
     * is unaffected because the slug is in the URL; the phone's open farm is
     * local state that `/me` knows nothing about.
     *
     * So the flag goes on the FARM, where a multi-farm client already reads
     * per-farm facts. A boolean on an endpoint with no tenant is the trap
     * itself; if a `/me`-level field is ever wanted it must NAME the farm
     * (`platformAdminOf: slug | null`).
     *
     * ## It decides what a client OFFERS, never what is allowed
     *
     * Every platform route still enforces `admin.manage` plus
     * `assertPlatformSupport`, which 404s outside the platform tenant. A client
     * that ignored this flag and called the routes anyway gets the same refusal
     * it would have got before. False everywhere when
     * `PLATFORM_TENANT_SLUG` is unset, matching `isPlatformTenant`'s fail-closed
     * behaviour.
     */
    isPlatform: boolean;
}

/**
 * Every farm the caller is an active member of, oldest membership first.
 *
 * `userId` MUST come from the authenticated session. Passing a value from the
 * request would turn this into an enumeration of someone else's farms.
 */
export async function listMyFarms(userId: string): Promise<MyFarm[]> {
    const rows = await prisma.tenantMembership.findMany({
        where: {
            userId,
            status: 'ACTIVE',
            // A removed farm must not appear — see the docblock.
            tenant: { deletedAt: null },
        },
        orderBy: { createdAt: 'asc' },
        select: {
            role: true,
            tenant: { select: { id: true, slug: true, name: true } },
        },
    });

    return rows.map((m) => ({
        id: m.tenant.id,
        slug: m.tenant.slug,
        name: m.tenant.name,
        role: m.role,
        // Computed per row from the env var rather than stored on the tenant:
        // which farm is the platform one is DEPLOYMENT configuration, not a
        // property of the farm, and a stored flag would survive a var change
        // and disagree with every gate that reads the var.
        isPlatform: isPlatformTenant(m.tenant.slug),
    }));
}
