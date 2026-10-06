/**
 * Epic O-2 — tenant creation under an organization.
 *
 * Composes:
 *   1. `prisma.tenant.create` with `organizationId` set + a freshly-
 *      generated DEK (mirrors `createTenantWithDek`).
 *   2. OWNER `TenantMembership` for the creator (the user named on the
 *      OrgContext that authorised the request).
 *   3. `TenantOnboarding` row (matches the platform-admin
 *      `createTenantWithOwner` shape).
 *   4. After the transaction commits — `provisionAllOrgAdminsToTenant`
 *      so every existing ORG_ADMIN of the org gets an AUDITOR
 *      membership in the new tenant.
 *
 * The creator's OWNER membership has `provisionedByOrgId = NULL` —
 * it's manually granted, not auto-provisioned. If the creator is later
 * removed as ORG_ADMIN, `deprovisionOrgAdmin` will NOT touch their
 * OWNER row (the predicate requires `provisionedByOrgId === orgId`).
 *
 * The provision call's skipDuplicates ignores the creator's pre-
 * existing OWNER row — it's a no-op for that user. Other ORG_ADMINs
 * get fresh AUDITOR rows.
 */

import { Prisma } from '@prisma/client';

import prisma from '@/lib/prisma';
import { createFarmTenant } from '@/lib/security/tenant-key-manager';
import { provisionAllOrgAdminsToTenant } from './org-provisioning';
import { ConflictError, notFound } from '@/lib/errors/types';
import type { OrgContext } from '@/app-layer/types';
import { logger } from '@/lib/observability/logger';

export interface CreateTenantUnderOrgInput {
    name: string;
    slug: string;
}

export interface CreateTenantUnderOrgResult {
    tenant: { id: string; slug: string; name: string };
    /** Number of ORG_ADMINs auto-provisioned into the new tenant. The
     *  creator's OWNER row is excluded (skipped on the unique
     *  constraint), so this count covers the OTHER admins. */
    provisionedAdmins: number;
}

/**
 * Create a tenant linked to the org named on `ctx`. The caller must
 * have already passed the `canManageTenants` permission check at the
 * route layer.
 */
export async function createTenantUnderOrg(
    ctx: OrgContext,
    input: CreateTenantUnderOrgInput,
): Promise<CreateTenantUnderOrgResult> {
    const name = input.name.trim();
    const slug = input.slug.trim().toLowerCase();

    let tenantId = '';
    let tenantName = name;
    let tenantSlug = slug;

    // Returned OUT of the transaction rather than assigned to an outer `let`:
    // TypeScript cannot prove a closure ran, so an outer binding stays narrowed
    // to `null` and is not callable afterwards.
    let primeDekCache: () => void;

    try {
        primeDekCache = await prisma.$transaction(async (tx) => {
            // P3.3 — one helper, not a fourth replication of its body. The
            // cache prime is deliberately NOT called here: it would survive a
            // rollback and evict a live tenant's DEK. It runs after commit.
            const created = await createFarmTenant(
                { name, slug, organizationId: ctx.organizationId },
                tx,
            );
            const tenant = created.tenant;
            tenantId = tenant.id;
            tenantName = tenant.name;
            tenantSlug = tenant.slug;

            // OWNER membership for the creator. provisionedByOrgId is
            // intentionally NOT set here — this is a manually-granted
            // membership that survives the creator's potential later
            // removal from ORG_ADMIN status.
            await tx.tenantMembership.create({
                data: {
                    tenantId: tenant.id,
                    userId: ctx.userId,
                    role: 'OWNER',
                    status: 'ACTIVE',
                },
            });

            await tx.tenantOnboarding.create({
                data: { tenantId: tenant.id },
            });

            return created.primeDekCache;
        });
    } catch (err) {
        // Translate the Prisma unique-violation on Tenant.slug into a
        // friendlier 409. Other Prisma errors bubble as-is for the API
        // wrapper to render.
        if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === 'P2002'
        ) {
            throw new ConflictError(
                `A tenant with slug '${slug}' already exists`,
            );
        }
        throw err;
    }

    // P3.3 — prime the DEK cache now the transaction has COMMITTED. Doing it
    // inside would leave a key for a tenant that never existed if the
    // transaction rolled back, and the cache is an insertion-order LRU, so
    // each such entry evicts a live tenant's DEK. Skipping it is safe; it
    // costs one unwrap on first use.
    primeDekCache();

    // Auto-provision OTHER ORG_ADMINs into the new tenant. The creator
    // already has OWNER (higher than AUDITOR) — skipDuplicates skips
    // them. Other admins get AUDITOR rows tagged with provisionedByOrgId.
    let provisionedAdmins = 0;
    try {
        const result = await provisionAllOrgAdminsToTenant(
            ctx.organizationId,
            tenantId,
        );
        provisionedAdmins = result.created;
    } catch (err) {
        // Provisioning failure is logged but doesn't roll back the
        // tenant creation — the tenant is real and usable; the missing
        // AUDITOR rows can be backfilled by re-running provisioning
        // (it's idempotent). Operator visibility via the structured log.
        logger.warn('org-tenants.provision_after_create_failed', {
            component: 'org-tenants',
            organizationId: ctx.organizationId,
            tenantId,
            requestId: ctx.requestId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    logger.info('org-tenants.created', {
        component: 'org-tenants',
        organizationId: ctx.organizationId,
        tenantId,
        slug: tenantSlug,
        creatorUserId: ctx.userId,
        provisionedAdmins,
        requestId: ctx.requestId,
    });

    return {
        tenant: { id: tenantId, name: tenantName, slug: tenantSlug },
        provisionedAdmins,
    };
}

/**
 * Soft-delete ("remove") a tenant from the org admin panel.
 *
 * Sets `Tenant.deletedAt`, which the tenant resolver (getTenantContext →
 * 404), the portfolio + org tenant listings, the tenant picker, and the
 * JWT membership claims all filter on — so the tenant becomes
 * inaccessible immediately, everywhere, while its data is retained for
 * compliance and a possible restore. A hard purge (wiping the tenant's
 * rows) is a separate, deliberate operation and is NOT done here.
 *
 * Org-scoped: only a tenant that belongs to THIS org (and isn't already
 * removed) can be deleted — a foreign / unknown id is a `notFound`, so
 * an org admin can never reach across into another org's tenant.
 *
 * The caller MUST have passed the `canManageTenants` permission check at
 * the route layer.
 */
export async function deleteTenantUnderOrg(
    ctx: OrgContext,
    tenantId: string,
): Promise<{ tenant: { id: string; slug: string; name: string } }> {
    const tenant = await prisma.tenant.findFirst({
        where: {
            id: tenantId,
            organizationId: ctx.organizationId,
            deletedAt: null,
        },
        select: { id: true, slug: true, name: true },
    });
    if (!tenant) {
        throw notFound('Tenant not found in this organization');
    }

    await prisma.tenant.update({
        where: { id: tenant.id },
        data: { deletedAt: new Date() },
    });

    logger.info('org-tenants.deleted', {
        component: 'org-tenants',
        organizationId: ctx.organizationId,
        tenantId: tenant.id,
        slug: tenant.slug,
        deletedByUserId: ctx.userId,
        requestId: ctx.requestId,
    });

    return { tenant };
}
