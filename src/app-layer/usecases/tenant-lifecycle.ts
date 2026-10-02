/**
 * Epic 1, PR 2 — Tenant lifecycle usecases.
 *
 * Provides two platform-admin operations that guarantee every tenant
 * has at least one ACTIVE OWNER at all times:
 *
 *   - `createTenantWithOwner` — atomic Tenant + DEK + OWNER
 *     membership + TenantOnboarding in a single transaction. The
 *     creator's email is looked up or placeholder-created so the
 *     first sign-in populates the rest of the User row.
 *
 *   - `transferTenantOwnership` — promotes a new OWNER before
 *     demoting the current one, so the DB trigger
 *     `tenant_membership_last_owner_guard` is always satisfied during
 *     the two-step transition.
 *
 * Neither function requires a `RequestContext` — they are called from
 * platform-admin routes that authenticate via `PLATFORM_ADMIN_API_KEY`
 * rather than a user session. Audit entries use `actorType: 'PLATFORM_ADMIN'`.
 */

import prisma from '@/lib/prisma';
import { hashForLookup, hashForLookupCandidates } from '@/lib/security/encryption';
import { appendAuditEntry } from '@/lib/audit/audit-writer';
import { logger } from '@/lib/observability/logger';
import { ValidationError, NotFoundError, ConflictError } from '@/lib/errors/types';
import type { PrismaClient } from '@prisma/client';

// ─── createTenantWithOwner ──────────────────────────────────────────

export interface CreateTenantWithOwnerInput {
    name: string;
    slug: string;
    ownerEmail: string;
    /** Correlation id for audit entries; platform-admin has no user session. */
    requestId: string;
}

export interface CreateTenantWithOwnerResult {
    tenant: { id: string; slug: string; name: string };
    ownerUserId: string;
}

/**
 * Atomically create a Tenant (with wrapped DEK), an OWNER membership
 * for `ownerEmail`, and a TenantOnboarding row.
 *
 * `ownerEmail` is normalised (trimmed, lower-cased). If a User row
 * exists for that email it is reused; otherwise a placeholder User is
 * created with only the `email` field set — the rest populates on
 * first sign-in via OAuth.
 *
 * Two audit entries are written: TENANT_CREATED and
 * TENANT_MEMBERSHIP_GRANTED (with role:OWNER, reason:tenant_creation).
 */
export async function createTenantWithOwner(
    input: CreateTenantWithOwnerInput,
): Promise<CreateTenantWithOwnerResult> {
    const email = input.ownerEmail.trim().toLowerCase();

    // 1. Find-or-create the User row outside the main transaction so
    //    the upsert is idempotent and visible to the transaction below.
    // An upsert's `where` takes a UNIQUE SCALAR, so it cannot carry the candidate
    // list. Keyed on the primary hash alone it would MISS a row still holding the
    // previous hash mid-rotation and CREATE A SECOND `User` for an address that
    // already has one — the duplicate-User defect, arrived at from the write side.
    // So the candidate read runs first, and the upsert is reached only when no row
    // exists under EITHER key, where it still provides the ON CONFLICT guard
    // against two concurrent creates.
    const emailHash = hashForLookup(email);
    const user =
        (await prisma.user.findFirst({
            where: { emailHash: { in: hashForLookupCandidates(email) } },
            select: { id: true },
        })) ??
        (await prisma.user.upsert({
            where: { emailHash },
            update: {},
            create: { email, emailHash },
            select: { id: true },
        }));

    // 2. Wrap in a Prisma transaction so a midway failure rolls back
    //    the tenant row, the membership, and the onboarding row together.
    //    Note: createTenantWithDek calls prisma.tenant.create internally
    //    so we must pass the transaction client.
    let tenantId: string;
    let tenantSlug: string;
    let tenantName: string;

    await (prisma as PrismaClient).$transaction(async (tx) => {
        // 2a. Create Tenant + DEK.
        // createTenantWithDek uses the singleton prisma — we replicate
        // its logic here with the tx client so the row is created inside
        // the transaction boundary.
        const { generateAndWrapDek } = await import(
            '@/lib/security/tenant-keys'
        );
        const { dek: _dek, wrapped } = generateAndWrapDek();
        void _dek; // DEK bytes cached by createTenantWithDek's path; here we prime nothing

        const tenant = await tx.tenant.create({
            data: {
                name: input.name,
                slug: input.slug,
                encryptedDek: wrapped,
            },
            select: { id: true, slug: true, name: true },
        });
        tenantId = tenant.id;
        tenantSlug = tenant.slug;
        tenantName = tenant.name;

        // 2b. Create OWNER membership.
        await tx.tenantMembership.create({
            data: {
                tenantId: tenant.id,
                userId: user.id,
                role: 'OWNER',
                status: 'ACTIVE',
            },
        });

        // 2c. Create TenantOnboarding row.
        await tx.tenantOnboarding.create({
            data: { tenantId: tenant.id },
        });
    });

    // 3. Write hash-chained audit entries AFTER the transaction commits
    //    so the data is durable before the chain is extended.
    await appendAuditEntry({
        tenantId: tenantId!,
        userId: user.id,
        actorType: 'PLATFORM_ADMIN',
        entity: 'Tenant',
        entityId: tenantId!,
        action: 'TENANT_CREATED',
        requestId: input.requestId,
        detailsJson: {
            category: 'tenant',
            slug: tenantSlug!,
            name: tenantName!,
            ownerUserId: user.id,
            ownerEmail: email,
        },
    });

    await appendAuditEntry({
        tenantId: tenantId!,
        userId: user.id,
        actorType: 'PLATFORM_ADMIN',
        entity: 'TenantMembership',
        entityId: user.id,
        action: 'TENANT_MEMBERSHIP_GRANTED',
        requestId: input.requestId,
        detailsJson: {
            category: 'membership',
            role: 'OWNER',
            reason: 'tenant_creation',
            userId: user.id,
        },
    });

    logger.info('tenant-lifecycle.tenant_created_with_owner', {
        component: 'tenant-lifecycle',
        tenantId: tenantId!,
        slug: tenantSlug!,
        ownerUserId: user.id,
    });

    return {
        tenant: { id: tenantId!, slug: tenantSlug!, name: tenantName! },
        ownerUserId: user.id,
    };
}

// ─── transferTenantOwnership ─────────────────────────────────────────

export interface TransferTenantOwnershipInput {
    /** Either tenantId OR tenantSlug is required. */
    tenantId?: string;
    tenantSlug?: string;
    currentOwnerUserId: string;
    newOwnerEmail: string;
}

export interface TransferTenantOwnershipResult {
    fromOwnerId: string;
    toOwnerId: string;
}

/**
 * Transfer OWNER role from the current owner to a new tenant member.
 *
 * The new owner MUST already have an ACTIVE membership in the tenant.
 * This is a transfer (not an invite) — use the invite flow to add new
 * members first, then transfer ownership.
 *
 * The two-step sequence — promote new OWNER, then demote old OWNER —
 * satisfies the `tenant_membership_last_owner_guard` trigger because
 * the second OWNER exists before the first is removed.
 */
export async function transferTenantOwnership(
    input: TransferTenantOwnershipInput,
): Promise<TransferTenantOwnershipResult> {
    const email = input.newOwnerEmail.trim().toLowerCase();

    // Accept either tenantId or tenantSlug. If slug, resolve inside the
    // usecase so route handlers never touch prisma directly.
    let tenantId: string | undefined = input.tenantId;
    if (!tenantId && input.tenantSlug) {
        const tenant = await prisma.tenant.findUnique({
            where: { slug: input.tenantSlug },
            select: { id: true },
        });
        if (!tenant) {
            throw new NotFoundError(`Tenant not found: ${input.tenantSlug}`);
        }
        tenantId = tenant.id;
    }
    if (!tenantId) {
        throw new ValidationError('Either tenantId or tenantSlug is required.');
    }

    // 1. Resolve the new owner's User row.
    const newOwnerUser = await prisma.user.findFirst({
        where: { emailHash: { in: hashForLookupCandidates(email) } },
        select: { id: true },
    });
    if (!newOwnerUser) {
        throw new NotFoundError(`No user found with email: ${email}`);
    }

    // 2. Verify the new owner is an ACTIVE member of this tenant.
    const newMembership = await prisma.tenantMembership.findFirst({
        where: {
            tenantId: tenantId,
            userId: newOwnerUser.id,
            status: 'ACTIVE',
        },
        select: { id: true, role: true },
    });
    if (!newMembership) {
        throw new ValidationError(
            'New owner must already be an active tenant member. ' +
            'Use the invite flow to add them first, then transfer ownership.',
        );
    }

    if (newOwnerUser.id === input.currentOwnerUserId) {
        throw new ConflictError(
            'New owner is the same as the current owner.',
        );
    }

    // 3. Find the current owner membership.
    const currentMembership = await prisma.tenantMembership.findFirst({
        where: {
            tenantId: tenantId,
            userId: input.currentOwnerUserId,
            role: 'OWNER',
            status: 'ACTIVE',
        },
        select: { id: true },
    });
    if (!currentMembership) {
        throw new NotFoundError(
            'Current owner has no ACTIVE OWNER membership in this tenant.',
        );
    }

    // 4. Promote new OWNER first (satisfies the trigger), then demote old.
    await (prisma as PrismaClient).$transaction(async (tx) => {
        await tx.tenantMembership.update({
            where: { id: newMembership.id },
            data: { role: 'OWNER' },
        });
        await tx.tenantMembership.update({
            where: { id: currentMembership.id },
            data: { role: 'ADMIN' },
        });
    });

    // 5. Audit both sides.
    await appendAuditEntry({
        tenantId: tenantId,
        userId: input.currentOwnerUserId,
        actorType: 'PLATFORM_ADMIN',
        entity: 'TenantMembership',
        entityId: newMembership.id,
        action: 'TENANT_OWNERSHIP_TRANSFERRED',
        detailsJson: {
            category: 'membership',
            fromUserId: input.currentOwnerUserId,
            toUserId: newOwnerUser.id,
            newOwnerMembershipId: newMembership.id,
            previousOwnerMembershipId: currentMembership.id,
            previousOwnerNewRole: 'ADMIN',
        },
    });

    logger.info('tenant-lifecycle.ownership_transferred', {
        component: 'tenant-lifecycle',
        tenantId: tenantId,
        fromUserId: input.currentOwnerUserId,
        toUserId: newOwnerUser.id,
    });

    return {
        fromOwnerId: input.currentOwnerUserId,
        toOwnerId: newOwnerUser.id,
    };
}
