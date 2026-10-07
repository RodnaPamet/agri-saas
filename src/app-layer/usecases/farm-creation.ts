/**
 * P3.6 — a signed-in person creates a farm.
 *
 * ## What this is, and what it deliberately is not
 *
 * The brief reads "`POST /api/me/farms` and join requests", but the owner ruled
 * on 2026-10-06 that there are NO join requests: memberships are invite-only,
 * owners and admins are the farm's paying proprietors, and they sign up freely.
 * So this file creates a farm. There is no request model, no approval flow, and
 * no path by which asking becomes membership.
 *
 * The distinction that keeps that honest: the **creator's** own OWNER
 * membership is not a "join". Invite-only governs joining an EXISTING farm.
 * Creation delegates to `createTenantWithOwner` in `tenant-lifecycle.ts`, which
 * is already on `ALLOWLISTED_MEMBERSHIP_SITES`, so this file never touches
 * `tenantMembership` and P3.6 adds no ninth membership-creation site. That is
 * the property `tests/guardrails/no-auto-join.test.ts` enforces, and it holds
 * here by construction rather than by review.
 *
 * A person may hold SEVERAL farms (owner ruling, same day), so there is no
 * one-farm-per-account guard and a second call is not a conflict.
 */
import { randomBytes } from 'node:crypto';

import { createTenantWithOwner } from '@/app-layer/usecases/tenant-lifecycle';
import { isValidEik, looksLikeEgn } from '@/lib/bg-identifiers';
import { toSlug } from '@/lib/bg-transliterate';
import { hashForLookup } from '@/lib/security/encryption';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest } from '@/lib/errors/types';
import { getPermissionsForRole } from '@/lib/permissions';
import { logger } from '@/lib/observability/logger';
import type { RequestContext } from '@/app-layer/types';

export const FARM_NAME_MAX = 120;

/**
 * The caller, who has NO tenant.
 *
 * Deliberately not a `RequestContext`: that type requires a `tenantId`, and the
 * whole premise of this route is a person who either has no farm yet or is
 * adding another. Passing one would mean inventing a tenant id before the
 * tenant exists, and whatever was invented would flow into
 * `runWithAuditContext` and be written to the audit trail as fact.
 */
export interface FarmCreator {
    requestId: string;
    userId: string;
    /** Used to find-or-reuse the User row that becomes OWNER. */
    userEmail: string;
}

/**
 * How the caller's ЕИК was handled. Three states, and each is load-bearing.
 *
 * `pending_review` covers a claim that landed PENDING **and** one that landed
 * DISPUTED, deliberately. P3.4 requires byte-identical responses for a free, a
 * pending, and a verified-elsewhere ЕИК — so this value must not distinguish
 * them, or the creation endpoint becomes the enumeration oracle the claim
 * endpoint was designed to avoid. Both states mean the same thing to the
 * caller anyway: a human has to look at it.
 *
 * `deferred` is the honest answer when the claim row could not be written at
 * all. The farm is created and committed by then, so reporting
 * `pending_review` would be a lie and failing the request would strand a farm
 * the caller cannot see. They add the ЕИК from farm settings instead.
 */
export type IdentityVerificationState = 'not_requested' | 'pending_review' | 'deferred';

export interface CreateFarmInput {
    name: string;
    /** Optional: «Земеделски стопанин — физическо лице» supplies none. */
    eik?: string | null;
}

export interface CreateFarmResult {
    farm: { id: string; slug: string; name: string };
    identityVerification: IdentityVerificationState;
}

/** Attempts at a unique slug before giving up. */
const SLUG_ATTEMPTS = 4;

/**
 * A slug for `name`, with a short random suffix.
 *
 * The suffix is random rather than `Date.now()` (which the self-service
 * register route uses): two farms created in the same millisecond would collide
 * on a timestamp, and the retry below cannot distinguish that from any other
 * unique violation. Random keeps the retries independent.
 */
function candidateSlug(base: string): string {
    return `${base}-${randomBytes(4).toString('hex')}`;
}

export async function createFarmForUser(
    creator: FarmCreator,
    input: CreateFarmInput,
): Promise<CreateFarmResult> {
    const name = input.name?.trim() ?? '';
    // CODES, not prose. `tests/guards/no-server-authored-user-copy.test.ts`
    // counts a prose first argument against a downward ratchet, and exempts a
    // machine-readable code — because a code is what a client can translate,
    // whereas English thrown from a usecase reaches the iOS app and renders
    // raw. It is also why the ЕГН and ЕИК refusals below carry no Bulgarian:
    // that copy belongs in `messages/bg.json` on the client, not here.
    if (!name) throw badRequest('FARM_NAME_REQUIRED');
    if (name.length > FARM_NAME_MAX) {
        throw badRequest('FARM_NAME_TOO_LONG', { max: FARM_NAME_MAX });
    }

    // ── the ЕИК is validated BEFORE it is hashed or stored ───────────
    //
    // So a number that cannot exist never creates a row, never creates an
    // index entry, and never becomes a collision candidate — which keeps
    // DISPUTED meaning "two farms claim this" rather than "someone typed it
    // wrong". This rejection is NOT uniformity-constrained: "this number
    // cannot exist" is a statement about the checksum, and leaks nothing
    // about who holds it.
    const eik = input.eik?.trim() || null;
    if (eik !== null) {
        // ЕГН first. It is a personal identifier, and the point of the check is
        // to refuse it rather than to store it — so this must precede any
        // handling that could persist the value, including the hash.
        if (looksLikeEgn(eik)) throw badRequest('EIK_LOOKS_LIKE_EGN');
        if (!isValidEik(eik)) throw badRequest('EIK_INVALID');
    }

    const base = toSlug(name);
    // `toSlug` returns null when nothing survives transliteration — a name of
    // only punctuation or emoji. A farm with no addressable slug cannot be
    // routed to, so this is a 400 rather than a fallback slug nobody can read.
    if (!base) throw badRequest('FARM_NAME_NOT_SLUGGABLE');

    let created: { tenant: { id: string; slug: string; name: string } } | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < SLUG_ATTEMPTS && created === null; attempt += 1) {
        const slug = candidateSlug(base);
        try {
            const result = await createTenantWithOwner({
                name,
                slug,
                ownerEmail: creator.userEmail,
                requestId: creator.requestId,
            });
            created = { tenant: result.tenant };
        } catch (err) {
            // Only a slug collision is retryable. Anything else — a plan gate,
            // a DB outage — must surface rather than be retried three more
            // times under a different slug.
            if (!isUniqueViolation(err)) throw err;
            lastError = err;
            logger.warn('farm-creation.slug_collision_retry', {
                component: 'farm-creation',
                attempt: attempt + 1,
            });
        }
    }
    if (created === null) {
        logger.error('farm-creation.slug_exhausted', {
            component: 'farm-creation',
            attempts: SLUG_ATTEMPTS,
        });
        throw lastError ?? badRequest('FARM_SLUG_UNAVAILABLE');
    }

    const farm = created.tenant;
    const identityVerification = eik === null
        ? 'not_requested'
        : await fileIdentityClaim(creator, farm.id, eik);

    return { farm: { id: farm.id, slug: farm.slug, name: farm.name }, identityVerification };
}

/**
 * File the PENDING claim, in a SEPARATE transaction from the farm.
 *
 * ## Creation NEVER produces a DISPUTED row, and that is not an omission
 *
 * The first version of this function caught `P2002` here and inserted DISPUTED
 * instead. That branch could never fire. The partial unique index is
 * `(eikHash) WHERE status = 'VERIFIED'`, so a PENDING insert on an ЕИК another
 * farm already holds VERIFIED violates nothing — PENDING rows are free to pile
 * up, which is exactly what the partiality is for. An integration test caught
 * it; the code read as if it handled a collision it could not observe.
 *
 * So the collision is detected where it can be: at VERIFICATION (P3.9), when a
 * reviewer tries to promote a second claim to VERIFIED and the index refuses.
 * **A DISPUTED row is produced there, by that path, and nowhere else.** A
 * review console that expects creation to have marked disputes will never see
 * one.
 *
 * ## What that buys the enumeration property
 *
 * It makes it unconditional. There is no branch at creation time that could
 * differ by whether the ЕИК is taken — not merely a response shaped to look the
 * same, but one code path, one row shape, one value. Uniformity by
 * construction beats uniformity by care, because care is what rots.
 *
 * ## Why a separate transaction from the farm
 *
 * `FarmIdentityClaim` is fail-closed audited, so an audit-subsystem problem
 * aborts the claim write. On the farm's transaction that would roll the farm
 * back too, and the caller would lose the thing they came for because of a
 * problem with a secondary record. The farm is committed first, deliberately:
 * an unrecorded ЕИК is recoverable from settings, a farm that was never created
 * is not.
 */
async function fileIdentityClaim(
    creator: FarmCreator,
    tenantId: string,
    eik: string,
): Promise<IdentityVerificationState> {
    // OWNER, because the creator IS the owner of the farm just made. The role
    // and permissions are type-only here — `runInTenantContext` reads just
    // `tenantId`, `userId` and `requestId` — but filling them with anything
    // weaker would be a false statement that a later reader could rely on.
    const claimCtx: RequestContext = {
        requestId: creator.requestId,
        userId: creator.userId,
        tenantId,
        role: 'OWNER',
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: true,
            canAudit: true,
            canExport: true,
        },
        appPermissions: getPermissionsForRole('OWNER'),
    };

    try {
        await runInTenantContext(claimCtx, (db) =>
            db.farmIdentityClaim.create({
                data: {
                    tenantId,
                    eikHash: hashForLookup(eik, 'eik'),
                    status: 'PENDING',
                    claimedByUserId: creator.userId,
                },
            }),
        );
        return 'pending_review';
    } catch (err) {
        // The farm is already committed, so this cannot become a failed
        // request. Fail-closed auditing means an audit-subsystem problem lands
        // here rather than in a lost row — the trade the owner accepted, with
        // AUDIT_FAIL_CLOSED_ENABLED=0 as the operator escape hatch.
        logger.error('farm-creation.claim_deferred', {
            component: 'farm-creation',
            tenantId,
            reason: err instanceof Error ? err.message : 'unknown',
        });
        return 'deferred';
    }
}

/** Prisma's unique-violation code, without importing the error class. */
function isUniqueViolation(err: unknown): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: unknown }).code === 'P2002'
    );
}
