import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { closeExchangeThread } from '@/app-layer/usecases/exchange-messaging';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/{slug}/exchange/threads/{threadId}/close
 *
 * Closes the conversation. EITHER party may — a seller who could close with no
 * way back could silence a buyer mid-negotiation.
 *
 * There is no matching reopen endpoint on purpose: sending a message reopens
 * the thread, so the way back is the thing you were going to do anyway.
 * Idempotent — closing twice keeps the original timestamp.
 */
export const POST = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: p }: { params: Promise<{ tenantSlug: string; threadId: string }> },
    ) => {
        const params = await p;
        const ctx = await getTenantCtx(params, req);
        return jsonResponse(await closeExchangeThread(ctx, params.threadId));
    },
);
