import { RequestContext } from '../../types';
import { ControlRepository } from '../../repositories/ControlRepository';
import {
    assertCanReadControls, assertCanUpdateControl, assertCanLinkEvidence,
} from '../../policies/control.policies';
import { logEvent } from '../../events/audit';
import { notFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';

// ─── Evidence Links ───

export async function listEvidenceLinks(ctx: RequestContext, controlId: string) {
    assertCanReadControls(ctx);
    return runInTenantContext(ctx, (db) =>
        ControlRepository.listEvidenceLinks(db, ctx, controlId)
    );
}

/**
 * Combined Evidence-tab payload (#102 item 1 — tab-lazy).
 *
 * The Evidence tab renders two collections: `controlEvidenceLink`
 * rows (manual URL / file links) AND the `Evidence` entities
 * directly attached to the control. Both used to ride on the eager
 * `getById` payload; the tab now fetches them together on demand —
 * one round-trip, one SWR key.
 */
export async function getControlEvidenceTab(ctx: RequestContext, controlId: string) {
    assertCanReadControls(ctx);
    return runInTenantContext(ctx, async (db) => {
        const control = await db.control.findFirst({
            where: { id: controlId, tenantId: ctx.tenantId },
        });
        if (!control) throw notFound('Control not found');
        const [links, evidence] = await Promise.all([
            ControlRepository.listEvidenceLinks(db, ctx, controlId),
            db.evidence.findMany({
                where: { controlId, tenantId: ctx.tenantId },
                orderBy: { createdAt: 'desc' },
            }),
        ]);
        return { links, evidence };
    });
}

export async function linkEvidence(ctx: RequestContext, controlId: string, data: { kind: string; fileId?: string | null; url?: string | null; note?: string | null }) {
    assertCanLinkEvidence(ctx);
    return runInTenantContext(ctx, async (db) => {
        const link = await ControlRepository.linkEvidence(db, ctx, controlId, data);
        if (!link) throw notFound('Control not found');

        await logEvent(db, ctx, {
            action: 'CONTROL_EVIDENCE_LINKED',
            entityType: 'Control',
            entityId: controlId,
            details: `Evidence linked: ${data.kind}${data.url ? ` (${data.url})` : ''}`,
            detailsJson: { category: 'relationship', operation: 'linked', sourceEntity: 'Control', sourceId: controlId, targetEntity: 'Evidence', targetId: data.fileId || 'url', relation: data.kind },
        });
        return link;
    });
}

export async function unlinkEvidence(ctx: RequestContext, controlId: string, linkId: string) {
    assertCanLinkEvidence(ctx);
    return runInTenantContext(ctx, async (db) => {
        const result = await ControlRepository.unlinkEvidence(db, ctx, controlId, linkId);
        if (!result) throw notFound('Evidence link not found');

        await logEvent(db, ctx, {
            action: 'CONTROL_EVIDENCE_UNLINKED',
            entityType: 'Control',
            entityId: controlId,
            details: `Evidence link removed: ${linkId}`,
            detailsJson: { category: 'relationship', operation: 'unlinked', sourceEntity: 'Control', sourceId: controlId, targetEntity: 'EvidenceLink', targetId: linkId },
        });
        return { success: true };
    });
}

// ─── Asset Linking ───

export async function linkAssetToControl(ctx: RequestContext, controlId: string, assetId: string) {
    assertCanUpdateControl(ctx);
    return runInTenantContext(ctx, async (db) => {
        const link = await ControlRepository.linkAsset(db, ctx, controlId, assetId);
        if (!link) throw notFound('Control not found');
        return link;
    });
}

export async function unlinkAssetFromControl(ctx: RequestContext, controlId: string, assetId: string) {
    assertCanUpdateControl(ctx);
    return runInTenantContext(ctx, async (db) => {
        const result = await ControlRepository.unlinkAsset(db, ctx, controlId, assetId);
        if (!result) throw notFound('Control or asset link not found');
        return { success: true };
    });
}
