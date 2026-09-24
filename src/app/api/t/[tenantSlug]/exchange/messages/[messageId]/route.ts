import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { deleteExchangeMessage } from '@/app-layer/usecases/exchange-messaging';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * DELETE /api/t/{slug}/exchange/messages/{messageId}
 *
 * Retracts a message the CALLER sent. A tombstone: the message keeps its place
 * in the other party's scrollback and renders as removed, because a hole where
 * something was read reads as data loss rather than as a retraction.
 */
export const DELETE = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: p }: { params: Promise<{ tenantSlug: string; messageId: string }> },
    ) => {
        const params = await p;
        const ctx = await getTenantCtx(params, req);
        return jsonResponse(await deleteExchangeMessage(ctx, params.messageId));
    },
);
