import { getTenantCtx } from '@/app-layer/context';
import { sendExchangeMessage } from '@/app-layer/usecases/exchange-messaging';
import { SendExchangeMessageSchema } from '@/app-layer/schemas/exchange-messaging.schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

/** POST /api/t/{slug}/exchange/threads/{threadId}/messages — say something. */
export const POST = withApiErrorHandling(
    withValidatedBody(
        SendExchangeMessageSchema,
        async (
            req,
            { params: p }: { params: Promise<{ tenantSlug: string; threadId: string }> },
            body,
        ) => {
            const params = await p;
            const ctx = await getTenantCtx(params, req);
            const msg = await sendExchangeMessage(ctx, params.threadId, body.body);
            return jsonResponse(msg, { status: 201 });
        },
    ),
);
