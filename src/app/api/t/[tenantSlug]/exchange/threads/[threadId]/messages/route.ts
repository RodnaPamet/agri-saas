import { getTenantCtx } from '@/app-layer/context';
import { sendExchangeMessage } from '@/app-layer/usecases/exchange-messaging';
import { SendExchangeMessageSchema } from '@/app-layer/schemas/exchange-messaging.schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { EXCHANGE_MESSAGE_LIMIT } from '@/lib/security/rate-limit-middleware';
import { messageRateBucket } from '@/lib/security/exchange-message-bucket';

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
            const msg = await sendExchangeMessage(ctx, params.threadId, body.body, req.headers.get('Idempotency-Key'));
            return jsonResponse(msg, { status: 201 });
        },
    ),
    {
        rateLimit: {
            // SHARED across the tenant's users, because the flood lands on
            // the recipient's bell and every sender is a legitimate member
            // of the sending tenant. The default (IP, userId) key would hand
            // a ten-user tenant ten budgets aimed at one person — #1161.
            config: EXCHANGE_MESSAGE_LIMIT,
            scope: 'exchange-message',
            getBucket: messageRateBucket,
        },
    },
);
