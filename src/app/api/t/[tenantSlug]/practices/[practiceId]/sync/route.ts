import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { runAutomationForPractice } from '@/app-layer/usecases/integrations';
import { withApiErrorHandling } from '@/lib/errors/api';
import { forbidden } from '@/lib/errors/types';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/[tenantSlug]/practices/[practiceId]/sync
 *
 * Manually trigger an automation sync (check) for a practice.
 * Requires an active integration connection for the practice's provider.
 * Returns the execution result immediately (synchronous for now).
 */
export const POST = withApiErrorHandling(async (
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ tenantSlug: string; practiceId: string }> }
) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    if (!ctx.permissions?.canWrite) throw forbidden('Write permission required');

    const result = await runAutomationForPractice(ctx, params.practiceId, {
        triggeredBy: 'manual',
    });

    return jsonResponse(result);
});

/**
 * GET /api/t/[tenantSlug]/practices/[practiceId]/sync
 *
 * Returns the current sync mapping status for this practice.
 * Used to drive the conflict badge on the practice detail page.
 */
export const GET = withApiErrorHandling(async (
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ tenantSlug: string; practiceId: string }> }
) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);

    const { PrismaSyncMappingStore } = await import('@/app-layer/integrations/prisma-sync-store');
    const { runInTenantContext } = await import('@/lib/db-context');

    // Fetch the practice's automationKey to derive the provider
    const practice = await runInTenantContext(ctx, async (db) => {

        return db.practice.findFirst({
            where: { id: params.practiceId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, automationKey: true },
        });
    });

    if (!practice?.automationKey) {
        return jsonResponse({ syncStatus: null, provider: null });
    }

    const [provider] = practice.automationKey.split('.');
    const store = new PrismaSyncMappingStore();

    const mapping = await store.findByLocalEntity(
        ctx.tenantId,
        provider,
        'practice',
        params.practiceId,
    );

    return jsonResponse({
        syncStatus: mapping?.syncStatus ?? null,
        lastSyncedAt: mapping?.lastSyncedAt ?? null,
        lastSyncDirection: mapping?.lastSyncDirection ?? null,
        errorMessage: mapping?.errorMessage ?? null,
        provider,
    });
});
