import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { openExchangeThread } from '@/app-layer/usecases/exchange-messaging';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/{slug}/exchange/listings/{listingId}/thread
 *
 * Open the conversation for a listing, or return the one already open.
 * IDEMPOTENT — a second tap returns the same thread rather than a second one,
 * so a client may call it on every "message seller" press without checking.
 */
export const POST = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: p }: { params: Promise<{ tenantSlug: string; listingId: string }> },
    ) => {
        const params = await p;
        const ctx = await getTenantCtx(params, req);
        const thread = await openExchangeThread(ctx, params.listingId);
        return jsonResponse(thread, { status: thread.created ? 201 : 200 });
    },
);
