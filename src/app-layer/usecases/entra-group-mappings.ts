/**
 * EI-2 — CRUD for `TenantEntraGroupMapping` (Entra security-group → IC role).
 *
 * Admin-gated, tenant-scoped (runs under RLS via `runInTenantContext`), and
 * audit-logged. EI-3 consumes these rows at sign-in via `resolveRoleFromGroups`
 * to sync a member's role. Mirrors the sibling `entra-provider` usecase.
 */
import { Prisma } from '@prisma/client';
import { RequestContext } from '../types';
import { assertCanAdmin } from '../policies/common';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { codedConflict, notFound } from '@/lib/errors/types';
import {
    EntraGroupMappingCreateSchema,
    EntraGroupMappingUpdateSchema,
} from '../schemas/entra-group-mapping.schemas';

export async function listEntraGroupMappings(ctx: RequestContext) {
    assertCanAdmin(ctx);
    return runInTenantContext(ctx, (db) =>
        db.tenantEntraGroupMapping.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
            take: 500,
        }),
    );
}

export async function createEntraGroupMapping(ctx: RequestContext, raw: unknown) {
    assertCanAdmin(ctx);
    const input = EntraGroupMappingCreateSchema.parse(raw);

    return runInTenantContext(ctx, async (db) => {
        let row;
        try {
            row = await db.tenantEntraGroupMapping.create({
                data: {
                    tenantId: ctx.tenantId,
                    aadGroupId: input.aadGroupId,
                    aadGroupName: input.aadGroupName,
                    role: input.role,
                    priority: input.priority,
                    createdByUserId: ctx.userId,
                },
            });
        } catch (e) {
            if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
                // Coded for the same reason as the other P2002 refusals in
                // this sweep — see `createInquiry` in exchange.ts (#1391).
                throw codedConflict(
                    'ENTRA_GROUP_MAPPING_EXISTS',
                    'A mapping for this Entra group already exists.',
                );
            }
            throw e;
        }

        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'TenantEntraGroupMapping',
            entityId: row.id,
            details: `Mapped Entra group ${input.aadGroupId} → ${input.role}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'TenantEntraGroupMapping',
                operation: 'created',
                after: { aadGroupId: input.aadGroupId, role: input.role, priority: input.priority },
                summary: `Entra group mapping created (${input.role})`,
            },
        });

        return row;
    });
}

export async function updateEntraGroupMapping(
    ctx: RequestContext,
    mappingId: string,
    raw: unknown,
) {
    assertCanAdmin(ctx);
    const input = EntraGroupMappingUpdateSchema.parse(raw);

    return runInTenantContext(ctx, async (db) => {
        const existing = await db.tenantEntraGroupMapping.findFirst({
            where: { id: mappingId, tenantId: ctx.tenantId },
        });
        if (!existing) throw notFound('Group mapping not found');

        const row = await db.tenantEntraGroupMapping.update({
            where: { id: existing.id },
            data: {
                ...(input.aadGroupName !== undefined ? { aadGroupName: input.aadGroupName } : {}),
                ...(input.role !== undefined ? { role: input.role } : {}),
                ...(input.priority !== undefined ? { priority: input.priority } : {}),
            },
        });

        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'TenantEntraGroupMapping',
            entityId: row.id,
            details: `Updated Entra group mapping ${row.aadGroupId}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'TenantEntraGroupMapping',
                operation: 'updated',
                before: {
                    role: existing.role,
                    priority: existing.priority,
                    aadGroupName: existing.aadGroupName,
                },
                after: { role: row.role, priority: row.priority, aadGroupName: row.aadGroupName },
                summary: 'Entra group mapping updated',
            },
        });

        return row;
    });
}

export async function deleteEntraGroupMapping(ctx: RequestContext, mappingId: string) {
    assertCanAdmin(ctx);

    return runInTenantContext(ctx, async (db) => {
        const existing = await db.tenantEntraGroupMapping.findFirst({
            where: { id: mappingId, tenantId: ctx.tenantId },
        });
        if (!existing) throw notFound('Group mapping not found');

        await db.tenantEntraGroupMapping.delete({ where: { id: existing.id } });

        await logEvent(db, ctx, {
            action: 'DELETE',
            entityType: 'TenantEntraGroupMapping',
            entityId: existing.id,
            details: `Deleted Entra group mapping ${existing.aadGroupId}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'TenantEntraGroupMapping',
                operation: 'deleted',
                before: { aadGroupId: existing.aadGroupId, role: existing.role },
                summary: 'Entra group mapping deleted',
            },
        });

        return { id: existing.id };
    });
}
