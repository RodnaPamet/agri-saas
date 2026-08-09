import { RequestContext } from '../../types';
import { PracticeRepository } from '../../repositories/PracticeRepository';
import {
    assertCanReadPractices, assertCanUpdatePractice, assertCanLinkEvidence,
} from '../../policies/practice.policies';
import { logEvent } from '../../events/audit';
import { notFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';

// ─── Evidence Links ───

export async function listEvidenceLinks(ctx: RequestContext, practiceId: string) {
    assertCanReadPractices(ctx);
    return runInTenantContext(ctx, (db) =>
        PracticeRepository.listEvidenceLinks(db, ctx, practiceId)
    );
}

/**
 * Combined Evidence-tab payload (#102 item 1 — tab-lazy).
 *
 * The Evidence tab renders two collections: `practiceEvidenceLink`
 * rows (manual URL / file links) AND the `Evidence` entities
 * directly attached to the practice. Both used to ride on the eager
 * `getById` payload; the tab now fetches them together on demand —
 * one round-trip, one SWR key.
 */
export async function getPracticeEvidenceTab(ctx: RequestContext, practiceId: string) {
    assertCanReadPractices(ctx);
    return runInTenantContext(ctx, async (db) => {
        const practice = await db.practice.findFirst({
            where: { id: practiceId, tenantId: ctx.tenantId },
        });
        if (!practice) throw notFound('Practice not found');
        const [links, evidence] = await Promise.all([
            PracticeRepository.listEvidenceLinks(db, ctx, practiceId),
            db.evidence.findMany({
                where: { practiceId, tenantId: ctx.tenantId },
                orderBy: { createdAt: 'desc' },
            }),
        ]);
        return { links, evidence };
    });
}

export async function linkEvidence(ctx: RequestContext, practiceId: string, data: { kind: string; fileId?: string | null; url?: string | null; note?: string | null }) {
    assertCanLinkEvidence(ctx);
    return runInTenantContext(ctx, async (db) => {
        const link = await PracticeRepository.linkEvidence(db, ctx, practiceId, data);
        if (!link) throw notFound('Practice not found');

        await logEvent(db, ctx, {
            action: 'CONTROL_EVIDENCE_LINKED',
            entityType: 'Practice',
            entityId: practiceId,
            details: `Evidence linked: ${data.kind}${data.url ? ` (${data.url})` : ''}`,
            detailsJson: { category: 'relationship', operation: 'linked', sourceEntity: 'Practice', sourceId: practiceId, targetEntity: 'Evidence', targetId: data.fileId || 'url', relation: data.kind },
        });
        return link;
    });
}

export async function unlinkEvidence(ctx: RequestContext, practiceId: string, linkId: string) {
    assertCanLinkEvidence(ctx);
    return runInTenantContext(ctx, async (db) => {
        const result = await PracticeRepository.unlinkEvidence(db, ctx, practiceId, linkId);
        if (!result) throw notFound('Evidence link not found');

        await logEvent(db, ctx, {
            action: 'CONTROL_EVIDENCE_UNLINKED',
            entityType: 'Practice',
            entityId: practiceId,
            details: `Evidence link removed: ${linkId}`,
            detailsJson: { category: 'relationship', operation: 'unlinked', sourceEntity: 'Practice', sourceId: practiceId, targetEntity: 'EvidenceLink', targetId: linkId },
        });
        return { success: true };
    });
}

// ─── Asset Linking ───

export async function linkAssetToPractice(ctx: RequestContext, practiceId: string, assetId: string) {
    assertCanUpdatePractice(ctx);
    return runInTenantContext(ctx, async (db) => {
        const link = await PracticeRepository.linkAsset(db, ctx, practiceId, assetId);
        if (!link) throw notFound('Practice not found');
        return link;
    });
}

export async function unlinkAssetFromPractice(ctx: RequestContext, practiceId: string, assetId: string) {
    assertCanUpdatePractice(ctx);
    return runInTenantContext(ctx, async (db) => {
        const result = await PracticeRepository.unlinkAsset(db, ctx, practiceId, assetId);
        if (!result) throw notFound('Practice or asset link not found');
        return { success: true };
    });
}
