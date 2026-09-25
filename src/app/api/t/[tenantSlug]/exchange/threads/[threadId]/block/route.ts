import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { blockExchangeParty, unblockExchangeParty } from '@/app-layer/usecases/exchange-messaging';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST   /api/t/{slug}/exchange/threads/{threadId}/block  — refuse further contact
 * DELETE /api/t/{slug}/exchange/threads/{threadId}/block  — lift it
 *
 * SELLER ONLY. Addressed by thread rather than by tenant id so no client ever
 * sends another tenant's id, and so the caller provably has standing: you can
 * only block someone who has already written to you.
 *
 * Both are idempotent — the end state is what is asserted, not the transition.
 */
export const POST = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: p }: { params: Promise<{ tenantSlug: string; threadId: string }> },
    ) => {
        const params = await p;
        const ctx = await getTenantCtx(params, req);
        return jsonResponse(await blockExchangeParty(ctx, params.threadId));
    },
);

export const DELETE = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: p }: { params: Promise<{ tenantSlug: string; threadId: string }> },
    ) => {
        const params = await p;
        const ctx = await getTenantCtx(params, req);
        return jsonResponse(await unblockExchangeParty(ctx, params.threadId));
    },
);
