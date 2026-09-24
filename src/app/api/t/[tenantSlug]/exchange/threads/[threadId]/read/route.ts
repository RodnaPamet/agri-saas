import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { markExchangeThreadRead } from '@/app-layer/usecases/exchange-messaging';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/{slug}/exchange/threads/{threadId}/read
 *
 * Moves the caller's read pointer to now. MONOTONIC — safe to fire from two
 * tabs, out of order, or repeatedly; the pointer never travels backwards.
 */
export const POST = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: p }: { params: Promise<{ tenantSlug: string; threadId: string }> },
    ) => {
        const params = await p;
        const ctx = await getTenantCtx(params, req);
        return jsonResponse(await markExchangeThreadRead(ctx, params.threadId));
    },
);
