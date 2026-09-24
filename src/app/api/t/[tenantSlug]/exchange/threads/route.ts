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
        return jsonResponse({ threads: await listExchangeThreads(ctx) });
    },
);
