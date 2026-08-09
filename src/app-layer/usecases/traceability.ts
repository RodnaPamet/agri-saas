import { RequestContext } from '../types';
import { AssetPracticeRepository } from '../repositories/TraceabilityRepository';
import { logEvent } from '../events/audit';
import { forbidden } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';

function assertCanRead(ctx: RequestContext) {
    // All roles can read traceability
}

function assertCanManage(ctx: RequestContext) {
    // Epic 1 — OWNER is a superset of ADMIN per CLAUDE.md RBAC.
    if (!['OWNER', 'ADMIN', 'EDITOR'].includes(ctx.role)) {
        throw forbidden('Only OWNER, ADMIN, or EDITOR can manage mappings');
    }
}

// ─── Asset ↔ Practice ───
//
// The only traceability edge left after the risk register was removed.
// `<TraceabilityPanel>` reads it from BOTH directions — the practice detail
// page lists linked assets, the asset detail page lists linked practices —
// via `getPracticeTraceability` / `getAssetTraceability` below.

export async function mapAssetToPractice(ctx: RequestContext, assetId: string, practiceId: string, coverageType?: string, rationale?: string) {
    assertCanManage(ctx);
    return runInTenantContext(ctx, async (db) => {
        const link = await AssetPracticeRepository.link(db, ctx.tenantId, assetId, practiceId, coverageType || null, rationale || null, ctx.userId);
        await logEvent(db, ctx, { action: 'ASSET_CONTROL_LINKED', entityType: 'Asset', entityId: assetId, details: `Linked to practice ${practiceId}`, detailsJson: { category: 'relationship', operation: 'linked', sourceEntity: 'Asset', sourceId: assetId, targetEntity: 'Practice', targetId: practiceId, relation: coverageType || 'FULL' }, metadata: { practiceId, coverageType } });
        return link;
    });
}

export async function unmapAssetFromPractice(ctx: RequestContext, assetId: string, practiceId: string) {
    assertCanManage(ctx);
    return runInTenantContext(ctx, async (db) => {
        await AssetPracticeRepository.unlink(db, ctx.tenantId, assetId, practiceId);
        await logEvent(db, ctx, { action: 'ASSET_CONTROL_UNLINKED', entityType: 'Asset', entityId: assetId, details: `Unlinked from practice ${practiceId}`, detailsJson: { category: 'relationship', operation: 'unlinked', sourceEntity: 'Asset', sourceId: assetId, targetEntity: 'Practice', targetId: practiceId }, metadata: { practiceId } });
    });
}

// ─── Asset ↔ Risk ───
// Read side served by the traceability views below; the standalone
// list-by-asset / list-by-risk readers were dead and removed.



// ─── Traceability Views ───




// ─── Coverage Summary ───

// ─── Read side (TraceabilityPanel) ───
//
// The panel renders nothing until its fetch resolves — `#traceability-panel`
// only mounts once `data` is truthy — so deleting these readers did not
// degrade the tab, it left it permanently on "load failed". The risk arms
// (`getRiskTraceability`, and the `risks` key each of these used to return)
// went with the register; the shapes keep their entity-keyed form because
// the panel's `unwrap` helper and its optimistic cache writes index by it.

export async function getPracticeTraceability(ctx: RequestContext, practiceId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const assets = await AssetPracticeRepository.listByPractice(db, ctx.tenantId, practiceId);
        return { practiceId, assets };
    });
}

export async function getAssetTraceability(ctx: RequestContext, assetId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const practices = await AssetPracticeRepository.listByAsset(db, ctx.tenantId, assetId);
        return { assetId, practices };
    });
}
