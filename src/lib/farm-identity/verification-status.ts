/**
 * Is a farm's identity VERIFIED? (P3.5f, reading P3.4's `FarmIdentityClaim`.)
 *
 * One definition, because more than one consumer is coming: P3.5f gates the AI
 * budget on it, P3.9's staff console will display it, and P3.10 may gate more.
 * Three separate `status: 'VERIFIED'` queries would drift the moment DISPUTED
 * acquires a second meaning.
 *
 * ── what VERIFIED means, and what it does not ──
 *
 * A claim is VERIFIED only when a staff reviewer has promoted it. `PENDING` is
 * "submitted, nobody has looked", and `DISPUTED` is "collided with an existing
 * VERIFIED claim". Neither counts: `verifiedAt` is set on promotion and null in
 * every other state, including DISPUTED — a disputed claim was never verified,
 * which is why P3.4 keeps `disputedAt` as its own column rather than inferring
 * the reason from `updatedAt`.
 *
 * So this returns false for a farm that has claimed an ЕИК and is waiting. That
 * is the intended reading of "until the farm is verified": waiting is not
 * verified, and the budget gate is meant to make a speculative signup cost
 * nothing until a human has confirmed the farm is real.
 *
 * ── the read is tenant-scoped, and that is correct here ──
 *
 * `FarmIdentityClaim` carries a `tenantId` and is under RLS, so this runs in
 * tenant context and asks only "has MY farm a verified claim". That is not the
 * blind-read hazard RLS creates elsewhere: the dangerous pattern is checking
 * whether someone ELSE holds a value — a cross-tenant uniqueness pre-check
 * returns zero rows precisely when the incumbent belongs to another tenant,
 * which is why P3.4 put a partial UNIQUE index behind it rather than a lookup.
 * Asking about your own rows is exactly what RLS is for.
 */
import type { RequestContext } from '@/app-layer/types';
import { runInTenantContext } from '@/lib/db-context';
// PRIVILEGED, and only for the person-shaped questions at the bottom of this
// file: they are asked by a scheduled job with no tenant context, about a
// person who may belong to several farms. `isFarmVerified` above stays
// tenant-scoped through `runInTenantContext` and must not be changed to use
// this — a tenant-scoped question answered privileged is a widening nobody
// asked for.
import { prisma } from '@/lib/prisma';

/**
 * True when this tenant holds at least one VERIFIED `FarmIdentityClaim`.
 *
 * `count` rather than `findFirst`, so nothing about the claim — not the ЕИК
 * blind index, not the claimant — is loaded for a question whose answer is a
 * boolean. A caller that needs the claim itself should read it deliberately.
 */
export async function isFarmVerified(ctx: RequestContext): Promise<boolean> {
    const n = await runInTenantContext(ctx, (db) =>
        db.farmIdentityClaim.count({
            where: { tenantId: ctx.tenantId, status: 'VERIFIED' },
        }),
    );
    return n > 0;
}

/**
 * Does this PERSON belong to any verified farm? — P9.3d (#2937).
 *
 * Here rather than in the auto-hide job because this module is already the one
 * definition of «verified», and says why: *"One definition, because more than
 * one consumer is coming… Three separate `status: 'VERIFIED'` queries would
 * drift the moment DISPUTED acquires a second meaning."* A second notion of
 * verified living in a job is exactly that drift.
 *
 * ## Why it cannot reuse `isFarmVerified`
 *
 * That one takes a `RequestContext` and asks about `ctx.tenantId` under
 * `runInTenantContext`. This question is PERSON-shaped — a reporter is a
 * person, who may belong to several farms — and the caller is a scheduled job
 * with no tenant context at all. So it reads privileged and across tenants,
 * deliberately.
 *
 * ## What VERIFIED means here is inherited, not redefined
 *
 * A claim is VERIFIED only when a staff reviewer has promoted it. `PENDING` is
 * "submitted, nobody has looked" and `DISPUTED` is "collided with an existing
 * VERIFIED claim". Neither counts. That is what makes this attacker-resistant
 * in the way P9.3's threshold needs: nobody can mint a verified farm, so three
 * throwaway accounts cannot hide a competitor's post.
 *
 * ## Today it answers false for everybody
 *
 * Production holds ONE `FarmIdentityClaim`, status PENDING — so zero verified
 * farms, and the auto-hide threshold is arithmetically unreachable. That is the
 * owner's accepted position and the reason the job prints a denominator rather
 * than letting "nothing was ever hidden" read as "the rule is working".
 */
export async function isPersonFromVerifiedFarm(userId: string): Promise<boolean> {
    const n = await prisma.farmIdentityClaim.count({
        where: {
            status: 'VERIFIED',
            tenantId: {
                in: (
                    await prisma.tenantMembership.findMany({
                        where: { userId, status: 'ACTIVE' },
                        select: { tenantId: true },
                    })
                ).map((m) => m.tenantId),
            },
        },
    });
    return n > 0;
}

/**
 * How many people in `userIds` belong to a verified farm.
 *
 * ONE pair of queries for the whole set, not a call per person — the auto-hide
 * job asks about every reporter on a post, and a loop of `isPersonFromVerifiedFarm`
 * is the N+1 the D1 guardrail refuses.
 */
export async function verifiedFarmMembers(
    userIds: readonly string[],
): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const memberships = await prisma.tenantMembership.findMany({
        where: { userId: { in: [...userIds] }, status: 'ACTIVE' },
        select: { userId: true, tenantId: true },
    });
    if (memberships.length === 0) return new Set();
    const verified = new Set(
        (
            await prisma.farmIdentityClaim.findMany({
                where: {
                    status: 'VERIFIED',
                    tenantId: { in: [...new Set(memberships.map((m) => m.tenantId))] },
                },
                select: { tenantId: true },
            })
        ).map((c) => c.tenantId),
    );
    return new Set(
        memberships.filter((m) => verified.has(m.tenantId)).map((m) => m.userId),
    );
}
