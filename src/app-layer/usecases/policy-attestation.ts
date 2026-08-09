/**
 * Policy attestation — Audit Coherence S4 (2026-05-22).
 *
 * ISO 27001 §7.3 requires evidence that personnel have acknowledged
 * policies. The `PolicyAcknowledgement` model existed in the schema
 * but had no operational surface — no usecase, no API. This module
 * provides:
 *
 *   - `attestPolicy(ctx, policyId)` — current user records that they
 *     have read + accepted the policy's currently-published version.
 *     Idempotent on the `(policyVersionId, userId)` unique constraint.
 *   - `getPolicyAttestation(ctx, policyId, userId?)` — has the user
 *     attested the current version? Returns the row or null.
 *   - `listPolicyAttestations(ctx, policyId)` — admin/audit view of
 *     who has attested.
 *
 * Only PUBLISHED policies can be attested; attesting a DRAFT or
 * ARCHIVED version doesn't satisfy the ISO practice.
 */
import { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { assertCanRead, assertCanAdmin } from '../policies/common';
import { logEvent } from '../events/audit';
import { notFound, badRequest } from '@/lib/errors/types';
import { PolicyRepository } from '../repositories/PolicyRepository';

export interface AttestPolicyResult {
    acknowledgementId: string;
    policyVersionId: string;
    userId: string;
    acknowledgedAt: Date;
    /** True if this call created a new row; false if the user had already attested. */
    created: boolean;
}

/**
 * Record an attestation for the current user against the policy's
 * currently-published version.
 *
 * Authorization: any tenant member can attest a policy they have
 * read access to (`assertCanRead`). Attestation is a "I have read
 * this" gesture — not a privileged write.
 *
 * Idempotency: the schema's `@@unique([policyVersionId, userId])`
 * means a second call returns the existing row with `created: false`.
 */
export async function attestPolicy(
    ctx: RequestContext,
    policyId: string,
): Promise<AttestPolicyResult> {
    assertCanRead(ctx);

    return runInTenantContext(ctx, async (db) => {
        const policy = await PolicyRepository.getById(db, ctx, policyId);
        if (!policy) throw notFound('Policy not found');

        if (policy.status !== 'PUBLISHED') {
            throw badRequest(
                `Only PUBLISHED policies can be attested. ${policyId} is ${policy.status}.`,
            );
        }
        if (!policy.currentVersionId) {
            throw badRequest(
                'Policy is PUBLISHED but has no currentVersionId — administrator must re-publish.',
            );
        }

        // Idempotent upsert via the (policyVersionId, userId) unique.
        const existing = await db.policyAcknowledgement.findUnique({
            where: {
                policyVersionId_userId: {
                    policyVersionId: policy.currentVersionId,
                    userId: ctx.userId,
                },
            },
        });
        if (existing) {
            return {
                acknowledgementId: existing.id,
                policyVersionId: existing.policyVersionId,
                userId: existing.userId,
                acknowledgedAt: existing.acknowledgedAt,
                created: false,
            };
        }

        const row = await db.policyAcknowledgement.create({
            data: {
                policyVersionId: policy.currentVersionId,
                userId: ctx.userId,
            },
        });

        await logEvent(db, ctx, {
            action: 'POLICY_ATTESTED',
            entityType: 'Policy',
            entityId: policyId,
            details: `User attested policy version ${policy.currentVersionId}`,
            detailsJson: {
                category: 'access',
                entityName: 'Policy',
                summary: `User ${ctx.userId} attested policy ${policyId}`,
                after: {
                    policyVersionId: policy.currentVersionId,
                    userId: ctx.userId,
                },
            },
        });

        return {
            acknowledgementId: row.id,
            policyVersionId: row.policyVersionId,
            userId: row.userId,
            acknowledgedAt: row.acknowledgedAt,
            created: true,
        };
    });
}

/**
 * Get a single user's attestation status for the policy's current
 * version. `userId` defaults to the caller; passing a different
 * userId requires admin authority (an admin checking who has /
 * hasn't attested).
 */
export async function getPolicyAttestation(
    ctx: RequestContext,
    policyId: string,
    userId?: string,
) {
    assertCanRead(ctx);
    const targetUserId = userId ?? ctx.userId;
    if (targetUserId !== ctx.userId) {
        assertCanAdmin(ctx);
    }

    return runInTenantContext(ctx, async (db) => {
        const policy = await PolicyRepository.getById(db, ctx, policyId);
        if (!policy) throw notFound('Policy not found');
        if (!policy.currentVersionId) return null;

        return db.policyAcknowledgement.findUnique({
            where: {
                policyVersionId_userId: {
                    policyVersionId: policy.currentVersionId,
                    userId: targetUserId,
                },
            },
        });
    });
}

/**
 * List every attestation for a policy's current version. Admin-only.
 * Surfaces the auditor report: "show me who has attested this policy".
 */
export async function listPolicyAttestations(
    ctx: RequestContext,
    policyId: string,
) {
    assertCanAdmin(ctx);

    return runInTenantContext(ctx, async (db) => {
        const policy = await PolicyRepository.getById(db, ctx, policyId);
        if (!policy) throw notFound('Policy not found');
        if (!policy.currentVersionId) return [];

        return db.policyAcknowledgement.findMany({
            where: { policyVersionId: policy.currentVersionId },
            orderBy: { acknowledgedAt: 'desc' },
            include: {
                user: { select: { id: true, name: true, email: true } },
            },
        });
    });
}
