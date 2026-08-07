import { RequestContext } from '../../types';
import { ControlRepository } from '../../repositories/ControlRepository';
import { FrameworkRepository } from '../../repositories/FrameworkRepository';
import { assertCanReadControls, assertCanMapFramework } from '../../policies/control.policies';
import { notFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';

/**
 * Requirement ↔ control mapping — the join that says "this is what we do to
 * satisfy requirement X".
 *
 * These four functions used to live in `control/templates.ts` alongside the
 * control-template library (a pre-built catalogue of infosec controls a
 * tenant could install). The compliance uproot removed the template library;
 * the mapping itself is the part worth keeping, so it moved here rather than
 * dying with its old neighbours.
 */

export async function listFrameworkRequirements(ctx: RequestContext, frameworkKey: string) {
    assertCanReadControls(ctx);
    return runInTenantContext(ctx, async (db) => {
        const result = await FrameworkRepository.listRequirements(db, frameworkKey);
        if (result === null) throw notFound('Framework not found');
        return result;
    });
}

export async function mapRequirementToControl(
    ctx: RequestContext,
    controlId: string,
    requirementId: string,
) {
    assertCanMapFramework(ctx);
    return runInTenantContext(ctx, async (db) => {
        const control = await db.control.findFirst({
            where: { id: controlId, tenantId: ctx.tenantId },
        });
        if (!control) throw notFound('Control not found');

        return db.frameworkMapping.create({
            data: { fromRequirementId: requirementId, toControlId: controlId },
            include: { fromRequirement: { include: { framework: { select: { name: true } } } } },
        });
    });
}

export async function unmapRequirementFromControl(
    ctx: RequestContext,
    controlId: string,
    requirementId: string,
) {
    assertCanMapFramework(ctx);
    return runInTenantContext(ctx, async (db) => {
        const control = await db.control.findFirst({
            where: { id: controlId, tenantId: ctx.tenantId },
        });
        if (!control) throw notFound('Control not found');

        const mapping = await db.frameworkMapping.findFirst({
            where: { fromRequirementId: requirementId, toControlId: controlId },
        });
        if (!mapping) throw notFound('Mapping not found');

        await db.frameworkMapping.delete({ where: { id: mapping.id } });
        return { success: true };
    });
}

/**
 * Framework mappings for one control (#102 item 1 — tab-lazy).
 *
 * The Mappings tab fetches this on demand instead of reading an eager
 * `frameworkMappings` array. The payload shape matches what the page renders.
 */
export async function listControlMappings(ctx: RequestContext, controlId: string) {
    assertCanReadControls(ctx);
    return runInTenantContext(ctx, async (db) => {
        const control = await db.control.findFirst({
            where: { id: controlId, tenantId: ctx.tenantId },
        });
        if (!control) throw notFound('Control not found');
        return ControlRepository.listFrameworkMappings(db, ctx, controlId);
    });
}
