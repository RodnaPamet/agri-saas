/**
 * What the DATABASE says about a person's farms, for the one page that has to
 * disagree with the token (#1738).
 *
 * ## Why a read-side helper exists at all
 *
 * `memberships` is a JWT claim, minted at sign-in, and the Edge has no
 * database — that is the whole reason `/no-tenant` exists and the whole reason
 * someone who has just created a farm is refused entry to it. So the page's
 * job is to explain a DISAGREEMENT between two sources, and it cannot do that
 * from one of them.
 *
 * `/no-tenant` is a server component, so it can do the thing the Edge could
 * not: read Postgres. #1738 left that as an open question — *"whether the page
 * can tell them apart without a database read is the open question — the Edge
 * cannot, but `/no-tenant` is a page and pages can"* — and this is the answer.
 *
 * ## This is a READER, never a second producer of claims
 *
 * `applyMembershipClaims` in `src/auth.ts` is deliberately private so there is
 * exactly ONE producer of `memberships`, and that comment is emphatic about
 * why: a second producer that missed the ACTIVE filter, the deleted-tenant
 * filter, the ordering or the cap would be silently more or less permissive
 * than the cookie, in a population no fixture covers.
 *
 * Nothing here mints anything. It answers "which farms does the database grant
 * this person access to", and the only thing it must share with the producer
 * is the FILTER — because a filter that drifted would make the page's
 * diagnosis wrong rather than its authority wrong.
 * `tests/guards/membership-filter-is-shared.test.ts` pins the two against each
 * other, since TypeScript cannot: the producer's copy sits inside a private
 * function's `include`.
 *
 * Deliberately NOT shared with the producer: the `MAX_JWT_MEMBERSHIPS` slice.
 * The cap is what makes the cookie bounded, and applying it here would hide
 * exactly the farms a capped token cannot see — the one case where the page
 * most needs to know the database holds more than the token does.
 */
import prisma from '@/lib/prisma';

/** The shape the `memberships` claim carries (`src/auth.ts`). */
export interface TokenMembership {
    slug: string;
}

/**
 * Every tenant slug the database grants this person access to.
 *
 * The filter mirrors `applyMembershipClaims` exactly: ACTIVE membership, and
 * the tenant not soft-deleted. An org-removed tenant must not appear, or the
 * page would tell someone to sign in again to reach a farm that has been
 * deleted — advice that cannot work, which is the class of defect #1738 is.
 */
export async function accessGrantingTenantSlugs(userId: string): Promise<string[]> {
    const rows = await prisma.tenantMembership.findMany({
        where: { userId, status: 'ACTIVE', tenant: { deletedAt: null } },
        select: { tenant: { select: { slug: true } } },
    });
    return rows.map((r) => r.tenant.slug);
}

/**
 * The farms the database grants that this session's token does not carry.
 *
 * A SET difference rather than a count comparison, and the difference matters.
 * Both of `/no-tenant`'s callers land here — `no_tenant_access` (an empty
 * claim) and `cross_tenant` (a claim missing this URL's slug) — and a count
 * comparison answers the first correctly while missing a membership SWAP,
 * where one farm is removed and another added between sign-ins and the two
 * counts match. That person is as locked out as the farm creator and would
 * have been told to go and find an administrator.
 *
 * Non-empty means the session is STALE: signing in again fixes it, and no
 * invitation is needed. Empty means the person genuinely has no farm, which is
 * who the page's original message was written for.
 */
export function slugsTheTokenDoesNotKnow(
    dbSlugs: readonly string[],
    tokenMemberships: readonly TokenMembership[],
): string[] {
    const known = new Set(tokenMemberships.map((m) => m.slug));
    return dbSlugs.filter((slug) => !known.has(slug));
}
