/**
 * MFA Policy Usecases
 *
 * Tenant-scoped MFA policy management:
 * - getTenantSecuritySettings: read current MFA policy
 * - updateTenantMfaPolicy: ADMIN-only, update MFA policy and session settings
 * - getUserMfaStatus: check if current user has MFA enrolled for current tenant
 */
import { prisma } from '@/lib/prisma';
import type { RequestContext } from '../types';
import type { UpdateMfaPolicyInputType } from '../schemas/mfa.schemas';
import type { MfaPolicy } from '@prisma/client';
import { forbidden, badRequest } from '@/lib/errors/types';

// ─── Types ──────────────────────────────────────────────────────────

export interface TenantSecuritySettingsResult {
    mfaPolicy: MfaPolicy;
    sessionMaxAgeMinutes: number | null;
}

export interface UserMfaStatusResult {
    isEnrolled: boolean;
    isVerified: boolean;
    enrolledAt: Date | null;
    verifiedAt: Date | null;
    tenantMfaPolicy: MfaPolicy;
    mfaRequired: boolean;
}

// ─── Get Tenant Security Settings ───────────────────────────────────

/**
 * Returns the current MFA policy and session settings for the tenant.
 * Returns defaults (DISABLED, null) if no settings record exists.
 */
export async function getTenantSecuritySettings(
    ctx: RequestContext,
): Promise<TenantSecuritySettingsResult> {
    const settings = await prisma.tenantSecuritySettings.findUnique({
        where: { tenantId: ctx.tenantId },
        // SELECT is explicit, and narrow on purpose (#2723).
        //
        // `TenantSecuritySettings.auditStreamSecretEncrypted` is in
        // `ENCRYPTED_FIELDS` and the model is NOT in `GLOBAL_KEK_MODELS`, so it
        // decrypts under the TENANT's DEK — which `resolveTenantDekPair` takes
        // from the ALS audit context. Nothing in this file binds one, so an
        // unnarrowed read fetches that column as a `v2:` envelope with no error
        // and no log.
        //
        // That was never a live defect here: every call site below uses
        // `mfaPolicy` and `sessionMaxAgeMinutes` and never touches the secret.
        // It was one edit away from being one — somebody adding a field to a
        // returned object, which is not a change that invites suspicion. Same
        // shape `retention-notifications.ts` had before it was narrowed to
        // `select: { id: true }`, and the same fix.
        //
        // It also stops pulling a secret's ciphertext into process memory for
        // a read that wants a policy enum.
        select: { mfaPolicy: true, sessionMaxAgeMinutes: true },
    });

    return {
        mfaPolicy: settings?.mfaPolicy ?? 'DISABLED',
        sessionMaxAgeMinutes: settings?.sessionMaxAgeMinutes ?? null,
    };
}

// ─── Update Tenant MFA Policy ───────────────────────────────────────

/**
 * Updates the MFA policy for the tenant. ADMIN-only.
 * Creates the settings record if it doesn't exist.
 */
export async function updateTenantMfaPolicy(
    ctx: RequestContext,
    input: UpdateMfaPolicyInputType,
): Promise<TenantSecuritySettingsResult> {
    if (!ctx.permissions.canAdmin) {
        throw forbidden('Only admins can update MFA policy');
    }

    // ── Anti-lockout safeguard ───────────────────────────────────────
    // If switching to REQUIRED, verify at least one admin has MFA enrolled.
    // This prevents all admins from being locked out.
    if (input.mfaPolicy === 'REQUIRED') {
        const adminMemberships = await prisma.tenantMembership.findMany({
            where: {
                tenantId: ctx.tenantId,
                role: 'ADMIN',
            },
            select: { userId: true },
        });

        const adminUserIds = adminMemberships.map(m => m.userId);

        if (adminUserIds.length > 0) {
            const enrolledAdminCount = await prisma.userMfaEnrollment.count({
                where: {
                    userId: { in: adminUserIds },
                    tenantId: ctx.tenantId,
                    type: 'TOTP',
                    isVerified: true,
                },
            });

            if (enrolledAdminCount === 0) {
                throw badRequest(
                    'Cannot enable REQUIRED MFA: at least one admin must be enrolled in MFA first. ' +
                    'Please set up MFA for your account before enabling this policy.',
                );
            }
        }
    }

    const settings = await prisma.tenantSecuritySettings.upsert({
        where: { tenantId: ctx.tenantId },
        create: {
            tenantId: ctx.tenantId,
            mfaPolicy: input.mfaPolicy as MfaPolicy,
            sessionMaxAgeMinutes: input.sessionMaxAgeMinutes ?? null,
        },
        update: {
            mfaPolicy: input.mfaPolicy as MfaPolicy,
            sessionMaxAgeMinutes: input.sessionMaxAgeMinutes ?? null,
        },
        // An upsert RETURNS the row, so it decrypts like any read — see the
        // note on the findUnique above. Narrowed for the same reason.
        select: { mfaPolicy: true, sessionMaxAgeMinutes: true },
    });

    return {
        mfaPolicy: settings.mfaPolicy,
        sessionMaxAgeMinutes: settings.sessionMaxAgeMinutes,
    };
}


// ─── Get User MFA Status ────────────────────────────────────────────

/**
 * Returns the MFA enrollment status for the current user in the current tenant.
 * Includes whether MFA is required based on tenant policy.
 */
export async function getUserMfaStatus(
    ctx: RequestContext,
): Promise<UserMfaStatusResult> {
    const [enrollment, settings] = await Promise.all([
        prisma.userMfaEnrollment.findUnique({
            where: {
                userId_tenantId_type: {
                    userId: ctx.userId,
                    tenantId: ctx.tenantId,
                    type: 'TOTP',
                },
            },
        }),
        prisma.tenantSecuritySettings.findUnique({
            where: { tenantId: ctx.tenantId },
            // Only the policy is read here. Narrowed for the reason on the
            // first read in this file.
            select: { mfaPolicy: true },
        }),
    ]);

    const policy = settings?.mfaPolicy ?? 'DISABLED';

    return {
        isEnrolled: !!enrollment,
        isVerified: enrollment?.isVerified ?? false,
        enrolledAt: enrollment?.createdAt ?? null,
        verifiedAt: enrollment?.verifiedAt ?? null,
        tenantMfaPolicy: policy,
        mfaRequired: policy === 'REQUIRED',
    };
}
