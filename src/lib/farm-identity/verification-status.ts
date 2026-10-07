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
