/**
 * Staff review of farm identity claims (P3.9).
 *
 * ── the reviewer SUPPLIES the ЕИК; it is never disclosed to them ──
 *
 * This is the design decision the whole file turns on, and it follows from
 * P3.4 rather than fighting it. `FarmIdentityClaim` stores only a blind index,
 * deliberately: it is "the one place in the product that necessarily holds a
 * row per farm identity somebody typed, including identities that were typed
 * wrongly, speculatively, or by someone with no connection to the farm", so
 * holding the plaintext would make it the best enumeration target in the
 * database (that model's own schema header).
 *
 * So `verifyFarmClaim` takes the ЕИК as INPUT. The reviewer reads the farm's
 * name off the claim list, looks that name up in the Търговски регистър
 * themselves, and types the number they find. The console hashes it and
 * confirms it matches what the farm claimed.
 *
 * That is stronger than showing them the number, not a workaround for being
 * unable to. A console that displayed the claimed ЕИК would let a reviewer
 * approve it without ever opening the register — the approval would mean
 * "somebody typed something" rather than "this farm is that company". Making
 * the reviewer produce the number independently is what the signature is for.
 *
 * It also means the plaintext arrives exactly once, at promotion, which is
 * precisely when `FarmProfile.eik` can be written under the tenant DEK. The
 * number never sits in the claim table in any recoverable form.
 *
 * ── privileged access, and why that is not an oversight ──
 *
 * `FarmIdentityClaim` is `FORCE ROW LEVEL SECURITY` with a `superuser_bypass`
 * policy — `USING (current_setting('role') != 'app_user')`. Review is
 * inherently cross-tenant (the collision cases are two different farms), so
 * these functions use the privileged `prisma` singleton, the same pattern
 * `tenant-lifecycle.ts` uses for platform-admin work. An `app_user` read here
 * would return the silent zero that P3.4's integration test pins.
 */
import { Prisma } from '@prisma/client';

import prisma from '@/lib/prisma';
import { hashForLookup, hashForLookupCandidates } from '@/lib/security/encryption';
import { isValidEik } from '@/lib/bg-identifiers';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logger } from '@/lib/observability/logger';
import { appendAuditEntry } from '@/lib/audit/audit-writer';

/** Claims listed per page. Bounded — the console is a queue, not an export. */
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

export type ClaimStatus = 'PENDING' | 'VERIFIED' | 'DISPUTED';

/**
 * What a reviewer sees. Note the absence of any ЕИК field, including the hash:
 * the hash is not plaintext but it IS a stable per-identity token, so handing
 * it to a console would let anyone who can read a screenshot correlate two
 * farms' claims. The reviewer does not need it — they type the number instead.
 */
export interface ClaimForReview {
    id: string;
    tenantId: string;
    /** Null when the tenant row is gone; the client renders that case. */
    tenantName: string | null;
    tenantSlug: string | null;
    status: ClaimStatus;
    claimedByUserId: string;
    createdAt: Date;
    verifiedAt: Date | null;
    disputedAt: Date | null;
}

export interface ListClaimsOptions {
    status?: ClaimStatus;
    limit?: number;
    /** `createdAt` cursor; returns claims strictly older than this. */
    before?: Date;
}

/** The review queue, oldest first so a backlog drains instead of starving. */
export async function listFarmClaims(
    options: ListClaimsOptions = {},
): Promise<ClaimForReview[]> {
    const take = Math.min(Math.max(options.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);

    const rows = await prisma.farmIdentityClaim.findMany({
        where: {
            ...(options.status ? { status: options.status } : {}),
            ...(options.before ? { createdAt: { lt: options.before } } : {}),
        },
        // `select`, never the bare row: an `include`-shaped read here would
        // carry `eikHash` into the response the first time somebody widened it.
        select: {
            id: true,
            tenantId: true,
            status: true,
            claimedByUserId: true,
            createdAt: true,
            verifiedAt: true,
            disputedAt: true,
        },
        orderBy: { createdAt: 'asc' },
        take,
    });

    // The farm's NAME comes from a SECOND query, not a join. There is no
    // `tenant` relation to traverse: P3.4 made `tenantId` a plain column
    // "matching every other tenant-scoped model here", so the Prisma client
    // exposes no relation field at all. Two queries rather than one is the
    // cost of that choice, and it is bounded — one `IN` over at most `take`
    // ids.
    const tenantIds = [...new Set(rows.map((r) => r.tenantId))];
    const tenants = tenantIds.length
        ? await prisma.tenant.findMany({
              where: { id: { in: tenantIds } },
              select: { id: true, name: true, slug: true },
          })
        : [];
    const byId = new Map(tenants.map((t) => [t.id, t]));

    return rows.map((r) => {
        const t = byId.get(r.tenantId);
        return {
            id: r.id,
            tenantId: r.tenantId,
            // A claim whose tenant has been deleted still appears, with its
            // name NULL rather than a placeholder sentence. Dropping the row
            // would hide one a reviewer may need to dispose of, and throwing
            // would let one dead tenant break the queue — but a hard-coded
            // "(deleted tenant)" would be server-authored English reaching a
            // client, which `no-new-hardcoded-ui-string` holds on a ratchet
            // and which the client should render in Bulgarian anyway.
            tenantName: t?.name ?? null,
            tenantSlug: t?.slug ?? null,
            status: r.status as ClaimStatus,
            claimedByUserId: r.claimedByUserId,
            createdAt: r.createdAt,
            verifiedAt: r.verifiedAt,
            disputedAt: r.disputedAt,
        };
    });
}

export type VerifyOutcome =
    /** Promoted. `FarmProfile.eik` now holds the number the reviewer supplied. */
    | { result: 'VERIFIED' }
    /** Already VERIFIED — a double submit. Idempotent, nothing changed. */
    | { result: 'ALREADY_VERIFIED' }
    /** The ЕИК the reviewer typed does not match what this farm claimed. */
    | { result: 'EIK_MISMATCH' }
    /** Not a structurally valid ЕИК — rejected before any lookup. */
    | { result: 'EIK_INVALID' }
    /** No claim with that id. */
    | { result: 'NOT_FOUND' }
    /** Another farm already holds a VERIFIED claim on this ЕИК. Now DISPUTED. */
    | { result: 'DISPUTED_COLLISION' }
    /** The claim is DISPUTED; promoting it needs that resolved first. */
    | { result: 'ALREADY_DISPUTED' };

export interface VerifyFarmClaimInput {
    claimId: string;
    /** The ЕИК the reviewer found in the register. Never read from the row. */
    eik: string;
    /** Platform operator identifier, for the audit trail. */
    reviewedBy: string;
}

/**
 * Promote a claim to VERIFIED, if the supplied ЕИК matches it.
 *
 * The matching read uses the FULL candidate set (`hashForLookupCandidates`),
 * so a row hashed under the previous `LOOKUP_HMAC_KEY` still matches during a
 * rotation window — and the promotion REHASHES it under the current key.
 * Without the rehash the partial unique index would be split across two key
 * generations and would stop enforcing "one VERIFIED claim per ЕИК", which is
 * the gap P3.4's implementation note explicitly left to this path.
 */
export async function verifyFarmClaim(input: VerifyFarmClaimInput): Promise<VerifyOutcome> {
    const eik = input.eik.trim();

    // Checksum first, before any query. A number that cannot exist cannot
    // match a claim, so refusing here keeps malformed input away from the
    // lookup entirely — the same ordering `/api/public/eik-check` uses.
    if (!isValidEik(eik)) return { result: 'EIK_INVALID' };

    const claim = await prisma.farmIdentityClaim.findUnique({
        where: { id: input.claimId },
        select: { id: true, tenantId: true, status: true, eikHash: true },
    });
    if (!claim) return { result: 'NOT_FOUND' };
    if (claim.status === 'VERIFIED') return { result: 'ALREADY_VERIFIED' };
    if (claim.status === 'DISPUTED') return { result: 'ALREADY_DISPUTED' };

    // The prove-you-know-it check. The reviewer's number is hashed and
    // compared; a mismatch means they are looking at a different company than
    // the farm claimed, which is exactly the case review exists to catch.
    if (!hashForLookupCandidates(eik, 'eik').includes(claim.eikHash)) {
        logger.info('farm-identity-review.eik_mismatch', {
            component: 'farm-identity-review',
            event: 'claim_verify_eik_mismatch',
            claimId: claim.id,
            // The number is NOT logged. A mismatch log carrying the ЕИК the
            // reviewer typed would reintroduce the plaintext the claim table
            // deliberately avoids, in a place that is kept for longer.
        });
        return { result: 'EIK_MISMATCH' };
    }

    const currentHash = hashForLookup(eik, 'eik');

    try {
        // One transaction: promote the claim and write the profile together.
        // A VERIFIED claim whose profile never got the number would leave the
        // ДНЕВНИК export blank for a farm the register says is verified.
        await prisma.$transaction(async (tx) => {
            await tx.farmIdentityClaim.update({
                where: { id: claim.id },
                data: { status: 'VERIFIED', verifiedAt: new Date(), eikHash: currentHash },
            });

            // The ONLY write path to this field — see #1352 and the removal of
            // `eik` from the free-edit profile list in this PR.
            // `sanitizePlainText` on a checksum-validated digit string is a
            // no-op, and it is here anyway for the reason
            // `sanitize-rich-text-coverage` gives: encryption protects the
            // value at rest and does nothing for the ДНЕВНИК PDF, the
            // audit-pack share link or the SDK consumer that decrypts and
            // RENDERS it. The sanitiser belongs at the usecase, before the
            // repository write, regardless of how narrow the input already is.
            const safeEik = sanitizePlainText(eik);
            await tx.farmProfile.upsert({
                where: { tenantId: claim.tenantId },
                update: { eik: safeEik },
                create: { tenantId: claim.tenantId, eik: safeEik },
            });
        });
    } catch (err) {
        // P2002 on the partial unique index: another farm already holds a
        // VERIFIED claim on this ЕИК. Per #1194, collisions go to DISPUTED.
        //
        // In a SEPARATE transaction, necessarily — a constraint violation
        // aborts the one it occurred in, so the DISPUTED write cannot be a
        // catch inside the same block. Getting that wrong would leave the
        // claim PENDING while the response said DISPUTED.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            await prisma.farmIdentityClaim.update({
                where: { id: claim.id },
                data: { status: 'DISPUTED', disputedAt: new Date() },
            });
            logger.warn('farm-identity-review.collision', {
                component: 'farm-identity-review',
                event: 'claim_verify_collision',
                claimId: claim.id,
                tenantId: claim.tenantId,
            });
            await auditClaimReview(claim.tenantId, input.reviewedBy, claim.id, 'DISPUTED_COLLISION');
            return { result: 'DISPUTED_COLLISION' };
        }
        throw err;
    }

    await auditClaimReview(claim.tenantId, input.reviewedBy, claim.id, 'VERIFIED');
    logger.info('farm-identity-review.verified', {
        component: 'farm-identity-review',
        event: 'claim_verified',
        claimId: claim.id,
        tenantId: claim.tenantId,
    });
    return { result: 'VERIFIED' };
}

export interface DisputeFarmClaimInput {
    claimId: string;
    /** Why, for the audit trail. Not shown to the claiming farm. */
    reason: string;
    reviewedBy: string;
}

/**
 * Mark a claim DISPUTED without promoting it — the reviewer's "this is not
 * your farm" verdict, as distinct from the automatic collision case.
 *
 * Deliberately does NOT require the ЕИК. A reviewer who has established that
 * the claim is wrong may not have a correct number to supply, and demanding
 * one would make the refusal path harder than the approval path.
 */
export async function disputeFarmClaim(
    input: DisputeFarmClaimInput,
): Promise<{ result: 'DISPUTED' | 'NOT_FOUND' | 'ALREADY_VERIFIED' }> {
    const claim = await prisma.farmIdentityClaim.findUnique({
        where: { id: input.claimId },
        select: { id: true, tenantId: true, status: true },
    });
    if (!claim) return { result: 'NOT_FOUND' };
    // A VERIFIED claim is not disputable here: unwinding one has to also
    // unwind `FarmProfile.eik` and whatever has been filed from it, which is
    // a deliberate operator action and not a queue button.
    if (claim.status === 'VERIFIED') return { result: 'ALREADY_VERIFIED' };

    await prisma.farmIdentityClaim.update({
        where: { id: claim.id },
        data: { status: 'DISPUTED', disputedAt: new Date() },
    });
    await auditClaimReview(claim.tenantId, input.reviewedBy, claim.id, 'DISPUTED', input.reason);
    return { result: 'DISPUTED' };
}

/**
 * Audit AFTER the commit, and never fatal.
 *
 * Same reasoning the register route records: the transition is durable before
 * the hash chain extends, and failing the response over a lost audit write
 * would leave an operator unable to tell whether the promotion happened. It is
 * logged loudly instead of swallowed, because a missing review entry breaks
 * the provenance story for a farm's verified identity.
 */
async function auditClaimReview(
    tenantId: string,
    reviewedBy: string,
    claimId: string,
    outcome: string,
    reason?: string,
): Promise<void> {
    try {
        await appendAuditEntry({
            tenantId,
            userId: null,
            // PLATFORM_ADMIN, not USER: conflating a staff verification with a
            // farmer's own action would corrupt the provenance story for every
            // verified identity, which is the one thing this entry is for.
            actorType: 'PLATFORM_ADMIN',
            action: 'UPDATE',
            entity: 'FarmIdentityClaim',
            entityId: claimId,
            detailsJson: { outcome, reviewedBy, ...(reason ? { reason } : {}) },
        });
    } catch (err) {
        logger.error('farm-identity-review.audit_failed', {
            component: 'farm-identity-review',
            event: 'claim_review_audit_failed',
            claimId,
            outcome,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
