import { NextRequest, NextResponse } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import {
    getAuditPack, updateAuditPack, addAuditPackItems,
    freezeAuditPack, generateShareLink, revokeShare,
    exportAuditPack,
} from '@/app-layer/usecases/audit-readiness';
import { clonePackForRetest, storeExportArtifact } from '@/app-layer/usecases/audit-hardening';
import { withApiErrorHandling } from '@/lib/errors/api';
import { z } from 'zod';
import { FEATURES } from '@/lib/entitlements';
import { requireFeature } from '@/lib/entitlements-server';
import { jsonResponse } from '@/lib/api-response';

const UpdatePackSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    notes: z.string().max(5000).optional(),
}).strip();

const AddItemsSchema = z.object({
    items: z.array(z.object({
        entityType: z.enum(['PRACTICE', 'POLICY', 'EVIDENCE', 'FILE', 'ISSUE', 'READINESS_REPORT', 'FRAMEWORK_COVERAGE']),
        entityId: z.string().min(1),
        snapshotJson: z.string().optional(),
        sortOrder: z.number().int().optional(),
    })).min(1).max(2000),
}).strip();

const ShareSchema = z.object({
    expiresAt: z.string().optional(),
}).strip();

const RevokeShareSchema = z.object({
    shareId: z.string().min(1),
}).strip();

const CloneSchema = z.object({
    name: z.string().min(1).max(200).optional(),
}).strip();

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; packId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const url = new URL(req.url);
    const action = url.searchParams.get('action');

    if (action === 'export') {
        const format = (url.searchParams.get('format') as 'json' | 'csv') || 'json';
        const data = await exportAuditPack(ctx, params.packId, format);
        if (format === 'csv' && 'csv' in data) {
            return new NextResponse(data.csv, {
                headers: {
                    'Content-Type': 'text/csv',
                    'Content-Disposition': `attachment; filename="${data.filename}"`,
                },
            });
        }
        return jsonResponse(data);
    }

    return jsonResponse(await getAuditPack(ctx, params.packId));
});

export const PATCH = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; packId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const body = UpdatePackSchema.parse(await req.json());
    return jsonResponse(await updateAuditPack(ctx, params.packId, body));
});

export const POST = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; packId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const url = new URL(req.url);
    const action = url.searchParams.get('action');
    const raw = await req.json();

    if (action === 'items') {
        const body = AddItemsSchema.parse(raw);
        return jsonResponse(await addAuditPackItems(ctx, params.packId, body.items), { status: 201 });
    }
    if (action === 'freeze') {
        return jsonResponse(await freezeAuditPack(ctx, params.packId));
    }
    if (action === 'share') {
        // ─── Plan check: audit pack sharing requires PRO+ ───
        await requireFeature(ctx.tenantId, FEATURES.AUDIT_PACK_SHARING);
        const body = ShareSchema.parse(raw);
        return jsonResponse(await generateShareLink(ctx, params.packId, body.expiresAt), { status: 201 });
    }
    if (action === 'revoke-share') {
        const body = RevokeShareSchema.parse(raw);
        return jsonResponse(await revokeShare(ctx, body.shareId));
    }
    if (action === 'clone') {
        const body = CloneSchema.parse(raw);
        return jsonResponse(await clonePackForRetest(ctx, params.packId, body.name), { status: 201 });
    }
    if (action === 'store-export') {
        const { content, filename, mimeType } = raw;
        const result = await storeExportArtifact(ctx, params.packId, content, filename, mimeType || 'application/json');
        return jsonResponse(result, { status: 201 });
    }

    return jsonResponse({ error: 'Unknown action' }, { status: 400 });
});
