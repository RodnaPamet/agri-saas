import { RequestContext } from '../types';
import { ControlRiskRepository, AssetControlRepository, AssetRiskRepository } from '../repositories/TraceabilityRepository';
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

// ─── Control ↔ Risk ───





// ─── Asset ↔ Control ───
// The read side is served by `getAssetTraceability` / `getControlTraceability`
// below (the TraceabilityPanel reads those); the standalone list-by-asset /
// list-by-control readers were dead and removed.

export async function mapAssetToControl(ctx: RequestContext, assetId: string, controlId: string, coverageType?: string, rationale?: string) {
    assertCanManage(ctx);
    return runInTenantContext(ctx, async (db) => {
        const link = await AssetControlRepository.link(db, ctx.tenantId, assetId, controlId, coverageType || null, rationale || null, ctx.userId);
        await logEvent(db, ctx, { action: 'ASSET_CONTROL_LINKED', entityType: 'Asset', entityId: assetId, details: `Linked to control ${controlId}`, detailsJson: { category: 'relationship', operation: 'linked', sourceEntity: 'Asset', sourceId: assetId, targetEntity: 'Control', targetId: controlId, relation: coverageType || 'FULL' }, metadata: { controlId, coverageType } });
        return link;
    });
}

export async function unmapAssetFromControl(ctx: RequestContext, assetId: string, controlId: string) {
    assertCanManage(ctx);
    return runInTenantContext(ctx, async (db) => {
        await AssetControlRepository.unlink(db, ctx.tenantId, assetId, controlId);
        await logEvent(db, ctx, { action: 'ASSET_CONTROL_UNLINKED', entityType: 'Asset', entityId: assetId, details: `Unlinked from control ${controlId}`, detailsJson: { category: 'relationship', operation: 'unlinked', sourceEntity: 'Asset', sourceId: assetId, targetEntity: 'Control', targetId: controlId }, metadata: { controlId } });
    });
}

// ─── Asset ↔ Risk ───
// Read side served by the traceability views below; the standalone
// list-by-asset / list-by-risk readers were dead and removed.



// ─── Traceability Views ───




// ─── Coverage Summary ───

