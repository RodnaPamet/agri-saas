import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getExchangeThread } from '@/app-layer/usecases/exchange-messaging';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * GET /api/t/{slug}/exchange/threads/{threadId} — the scrollback.
 *
 * Messages come back oldest-first (reading order) but are SELECTED newest-first
 * and reversed, so a long thread returns its end rather than its beginning.
 */
export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: p }: { params: Promise<{ tenantSlug: string; threadId: string }> },
    ) => {
        const params = await p;
        const ctx = await getTenantCtx(params, req);
        const url = new URL(req.url);
        const limitRaw = url.searchParams.get('limit');
        return jsonResponse(
            await getExchangeThread(ctx, params.threadId, {
                before: url.searchParams.get('before'),
                limit: limitRaw ? Number(limitRaw) : undefined,
            }),
        );
    },
);
