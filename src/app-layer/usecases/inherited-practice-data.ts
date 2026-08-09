/**
 * Inherited practice data for Asset / Risk detail pages.
 *
 * Evidence and test plans attach ONLY to practices. An asset or risk
 * "has" neither directly — it inherits them from the practices it is
 * mapped to (PracticeAsset for assets, RiskPractice for risks). These
 * read-only aggregators gather the evidence / test plans across the
 * mapped practices and tag each row with its owning practice, so the
 * Asset/Risk Evidence and Tests tabs can surface them.
 *
 * Tenant isolation: every query runs inside `runInTenantContext`
 * (RLS-bound) AND filters by `ctx.tenantId` — defence in depth, same
 * as every other repository read.
 */
import { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import type { PrismaTx } from '@/lib/db-context';

const CONTROL_SELECT = { id: true, code: true, name: true } as const;
const AGG_TAKE = 200;

type PracticeRef = { id: string; code: string | null; name: string };

/** Resolve the practices mapped to an asset → (practiceId[], practice-by-id map). */
async function practicesForAsset(db: PrismaTx, tenantId: string, assetId: string) {
    const maps = await db.practiceAsset.findMany({
        where: { tenantId, assetId },
        select: { practiceId: true, practice: { select: CONTROL_SELECT } },
        take: AGG_TAKE,
    });
    return mapPractices(maps);
}

function mapPractices(
    maps: ReadonlyArray<{ practiceId: string; practice: PracticeRef | null }>,
): { practiceIds: string[]; byId: Map<string, PracticeRef> } {
    const byId = new Map<string, PracticeRef>();
    for (const m of maps) {
        if (m.practice) byId.set(m.practiceId, m.practice);
    }
    return { practiceIds: [...byId.keys()], byId };
}

async function evidenceForPractices(
    db: PrismaTx,
    tenantId: string,
    practiceIds: string[],
    byId: Map<string, PracticeRef>,
) {
    if (practiceIds.length === 0) return [];
    const evidence = await db.evidence.findMany({
        where: { tenantId, practiceId: { in: practiceIds }, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: AGG_TAKE,
    });
    return evidence.map((e) => ({ ...e, practice: e.practiceId ? byId.get(e.practiceId) ?? null : null }));
}

async function mappingsForPractices(
    db: PrismaTx,
    tenantId: string,
    practiceIds: string[],
    byId: Map<string, PracticeRef>,
) {
    if (practiceIds.length === 0) return [];
    // Practice → framework requirement links. Frameworks +
    // requirements are a GLOBAL catalogue (no tenantId), so the
    // tenant scope rides on PracticeRequirementLink.tenantId; the
    // requirement/framework are read through the relation.
    const links = await db.practiceRequirementLink.findMany({
        where: { tenantId, practiceId: { in: practiceIds } },
        select: {
            practiceId: true,
            requirement: {
                select: {
                    id: true,
                    code: true,
                    title: true,
                    framework: { select: { id: true, name: true, version: true } },
                },
            },
        },
        take: AGG_TAKE,
    });
    return links.map((l) => ({
        requirementId: l.requirement.id,
        code: l.requirement.code,
        title: l.requirement.title,
        framework: l.requirement.framework,
        practice: byId.get(l.practiceId) ?? null,
    }));
}

// ─── Public usecases ───

export function getAssetInheritedEvidence(ctx: RequestContext, assetId: string) {
    return runInTenantContext(ctx, async (db) => {
        const { practiceIds, byId } = await practicesForAsset(db, ctx.tenantId, assetId);
        return evidenceForPractices(db, ctx.tenantId, practiceIds, byId);
    });
}

export function getAssetInheritedMappings(ctx: RequestContext, assetId: string) {
    return runInTenantContext(ctx, async (db) => {
        const { practiceIds, byId } = await practicesForAsset(db, ctx.tenantId, assetId);
        return mappingsForPractices(db, ctx.tenantId, practiceIds, byId);
    });
}

