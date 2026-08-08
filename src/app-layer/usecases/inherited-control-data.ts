/**
 * Inherited control data for Asset / Risk detail pages.
 *
 * Evidence and test plans attach ONLY to controls. An asset or risk
 * "has" neither directly — it inherits them from the controls it is
 * mapped to (ControlAsset for assets, RiskControl for risks). These
 * read-only aggregators gather the evidence / test plans across the
 * mapped controls and tag each row with its owning control, so the
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

type ControlRef = { id: string; code: string | null; name: string };

/** Resolve the controls mapped to an asset → (controlId[], control-by-id map). */
async function controlsForAsset(db: PrismaTx, tenantId: string, assetId: string) {
    const maps = await db.controlAsset.findMany({
        where: { tenantId, assetId },
        select: { controlId: true, control: { select: CONTROL_SELECT } },
        take: AGG_TAKE,
    });
    return mapControls(maps);
}

function mapControls(
    maps: ReadonlyArray<{ controlId: string; control: ControlRef | null }>,
): { controlIds: string[]; byId: Map<string, ControlRef> } {
    const byId = new Map<string, ControlRef>();
    for (const m of maps) {
        if (m.control) byId.set(m.controlId, m.control);
    }
    return { controlIds: [...byId.keys()], byId };
}

async function evidenceForControls(
    db: PrismaTx,
    tenantId: string,
    controlIds: string[],
    byId: Map<string, ControlRef>,
) {
    if (controlIds.length === 0) return [];
    const evidence = await db.evidence.findMany({
        where: { tenantId, controlId: { in: controlIds }, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: AGG_TAKE,
    });
    return evidence.map((e) => ({ ...e, control: e.controlId ? byId.get(e.controlId) ?? null : null }));
}

async function mappingsForControls(
    db: PrismaTx,
    tenantId: string,
    controlIds: string[],
    byId: Map<string, ControlRef>,
) {
    if (controlIds.length === 0) return [];
    // Control → framework requirement links. Frameworks +
    // requirements are a GLOBAL catalogue (no tenantId), so the
    // tenant scope rides on ControlRequirementLink.tenantId; the
    // requirement/framework are read through the relation.
    const links = await db.controlRequirementLink.findMany({
        where: { tenantId, controlId: { in: controlIds } },
        select: {
            controlId: true,
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
        control: byId.get(l.controlId) ?? null,
    }));
}

// ─── Public usecases ───

export function getAssetInheritedEvidence(ctx: RequestContext, assetId: string) {
    return runInTenantContext(ctx, async (db) => {
        const { controlIds, byId } = await controlsForAsset(db, ctx.tenantId, assetId);
        return evidenceForControls(db, ctx.tenantId, controlIds, byId);
    });
}

export function getAssetInheritedMappings(ctx: RequestContext, assetId: string) {
    return runInTenantContext(ctx, async (db) => {
        const { controlIds, byId } = await controlsForAsset(db, ctx.tenantId, assetId);
        return mappingsForControls(db, ctx.tenantId, controlIds, byId);
    });
}

