import { RequestContext } from '../../types';
import { PracticeRepository } from '../../repositories/PracticeRepository';
import { FrameworkRepository } from '../../repositories/FrameworkRepository';
import { assertCanReadPractices, assertCanMapFramework } from '../../policies/practice.policies';
import { notFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';

/**
 * Requirement ↔ practice mapping — the join that says "this is what we do to
 * satisfy requirement X".
 *
 * These four functions used to live in `practice/templates.ts` alongside the
 * practice-template library (a pre-built catalogue of infosec practices a
 * tenant could install). The compliance uproot removed the template library;
 * the mapping itself is the part worth keeping, so it moved here rather than
 * dying with its old neighbours.
 */

export async function listFrameworkRequirements(ctx: RequestContext, frameworkKey: string) {
    assertCanReadPractices(ctx);
    return runInTenantContext(ctx, async (db) => {
        const result = await FrameworkRepository.listRequirements(db, frameworkKey);
        if (result === null) throw notFound('Framework not found');
        return result;
    });
}

export async function mapRequirementToPractice(
    ctx: RequestContext,
    practiceId: string,
    requirementId: string,
) {
    assertCanMapFramework(ctx);
    return runInTenantContext(ctx, async (db) => {
        const practice = await db.practice.findFirst({
            where: { id: practiceId, tenantId: ctx.tenantId },
        });
        if (!practice) throw notFound('Practice not found');

        return db.frameworkMapping.create({
            data: { fromRequirementId: requirementId, toPracticeId: practiceId },
            include: { fromRequirement: { include: { framework: { select: { name: true } } } } },
        });
    });
}

export async function unmapRequirementFromPractice(
    ctx: RequestContext,
    practiceId: string,
    requirementId: string,
) {
    assertCanMapFramework(ctx);
    return runInTenantContext(ctx, async (db) => {
        const practice = await db.practice.findFirst({
            where: { id: practiceId, tenantId: ctx.tenantId },
        });
        if (!practice) throw notFound('Practice not found');

        const mapping = await db.frameworkMapping.findFirst({
            where: { fromRequirementId: requirementId, toPracticeId: practiceId },
        });
        if (!mapping) throw notFound('Mapping not found');

        await db.frameworkMapping.delete({ where: { id: mapping.id } });
        return { success: true };
    });
}

/**
 * Framework mappings for one practice (#102 item 1 — tab-lazy).
 *
 * The Mappings tab fetches this on demand instead of reading an eager
 * `frameworkMappings` array. The payload shape matches what the page renders.
 */
export async function listPracticeMappings(ctx: RequestContext, practiceId: string) {
    assertCanReadPractices(ctx);
    return runInTenantContext(ctx, async (db) => {
        const practice = await db.practice.findFirst({
            where: { id: practiceId, tenantId: ctx.tenantId },
        });
        if (!practice) throw notFound('Practice not found');
        return PracticeRepository.listFrameworkMappings(db, ctx, practiceId);
    });
}
