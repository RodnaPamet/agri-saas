import { RequestContext } from '../types';
import { AssetControlRepository } from '../repositories/TraceabilityRepository';
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

// ─── Asset ↔ Control ───
//
// The only traceability edge left after the risk register was removed.
// `<TraceabilityPanel>` reads it from BOTH directions — the control detail
// page lists linked assets, the asset detail page lists linked controls —
// via `getControlTraceability` / `getAssetTraceability` below.

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

// ─── Read side (TraceabilityPanel) ───
//
// The panel renders nothing until its fetch resolves — `#traceability-panel`
// only mounts once `data` is truthy — so deleting these readers did not
// degrade the tab, it left it permanently on "load failed". The risk arms
// (`getRiskTraceability`, and the `risks` key each of these used to return)
// went with the register; the shapes keep their entity-keyed form because
// the panel's `unwrap` helper and its optimistic cache writes index by it.

export async function getControlTraceability(ctx: RequestContext, controlId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const assets = await AssetControlRepository.listByControl(db, ctx.tenantId, controlId);
        return { controlId, assets };
    });
}

export async function getAssetTraceability(ctx: RequestContext, assetId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const controls = await AssetControlRepository.listByAsset(db, ctx.tenantId, assetId);
        return { assetId, controls };
    });
}
