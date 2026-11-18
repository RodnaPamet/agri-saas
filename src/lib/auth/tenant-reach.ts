import prisma from '@/lib/prisma';

/**
 * Does `userId` have access that reaches BEYOND `tenantId`?
 *
 * True when the person holds an ACTIVE membership in any other tenant or any
 * org membership — exactly the two things `applyMembershipClaims` puts in a
 * session besides this tenant.
 *
 * Two tenant-controlled mechanisms act on a platform-wide `User` row: an SSO
 * identity provider (which signs the person in) and a SCIM token (which edits
 * their profile). Both are configured by that tenant's own ADMIN, and every
 * self-serve sign-up is the OWNER of a farm, so neither may act on a person
 * whose account is not wholly governed by that tenant (#3196, #3197). This is
 * the one definition of "wholly governed", so the two cannot drift.
 */
export async function reachesBeyondTenant(userId: string, tenantId: string): Promise<boolean> {
    const [elsewhere, orgCount] = await Promise.all([
        prisma.tenantMembership.count({
            where: { userId, status: 'ACTIVE', tenantId: { not: tenantId } },
        }),
        prisma.orgMembership.count({ where: { userId } }),
    ]);
    return elsewhere > 0 || orgCount > 0;
}
