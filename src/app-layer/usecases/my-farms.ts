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

export interface MyFarm {
    id: string;
    slug: string;
    name: string;
    role: Role;
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
    }));
}
