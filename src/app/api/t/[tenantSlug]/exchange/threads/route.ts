import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listExchangeThreads } from '@/app-layer/usecases/exchange-messaging';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * GET /api/t/{slug}/exchange/threads — the caller's conversations.
 *
 * Returns threads from BOTH sides: ones this tenant opened as a buyer and ones
 * opened against its own listings. `role` says which, per thread. Not ETagged:
 * an inbox whose point is unread state should not be served from a cache.
 */
export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: p }: { params: Promise<{ tenantSlug: string }> }) => {
        const ctx = await getTenantCtx(await p, req);
        const url = new URL(req.url);
        // Ids and cursors in the QUERY STRING are fine on the web, but note
        // `docs/ios-messaging-brief.md`: CFNetwork logs full request URLs, so
        // a cursor is the only thing that may travel this way — never a thread
        // or message id.
        const limitRaw = url.searchParams.get('limit');
        return jsonResponse(
            await listExchangeThreads(ctx, {
                cursor: url.searchParams.get('cursor'),
                limit: limitRaw ? Number(limitRaw) : undefined,
            }),
        );
    },
);
