import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import {
    savePushSubscription,
    removePushSubscription,
    saveApnsRegistration,
    removeApnsRegistration,
} from '@/app-layer/usecases/push-subscription';
import {
    PushRegistrationSchema,
    RemovePushRegistrationSchema,
} from '@/app-layer/schemas/push.schemas';
import { isWebPushConfigured } from '@/lib/notifications/web-push';
import { withValidatedBody } from '@/lib/validation/route';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { logger } from '@/lib/observability/logger';

type Ctx = { params: Promise<{ tenantSlug: string }> };

/**
 * Self-service device registration for a tenant member — both transports
 * since #1764.
 *
 * ## The 503 is per TRANSPORT, and that is the trap worth naming
 *
 * This route answered `503 push_not_configured` whenever `isWebPushConfigured()`
 * was false, so VAPID keys gated the whole endpoint. Left that way, an iPhone
 * registering a token would have been refused by a check about a key it does
 * not use — and the refusal would have looked like a server problem to a
 * client that had done everything right.
 *
 * So the web body keeps its VAPID gate and the APNs body does not reach it.
 *
 * ## An APNs token is accepted even though nothing sends to it yet
 *
 * Deliberate, and stated here rather than discovered. The transport (HTTP/2 to
 * Apple, a JWT signed with a `.p8`) is the third step of #1764 and needs a
 * production key. Refusing registration until then would keep the native
 * client blocked for no benefit: a token is the client telling us where it is,
 * and storing that is useful before we can use it.
 *
 * What would NOT be acceptable is the gap being invisible, so an accepted
 * token logs at WARN while there is no transport. "Wired is not delivered" —
 * the log is what makes the difference legible to an operator, and it is
 * meant to disappear when step 3 lands.
 */
export const POST = withApiErrorHandling(
    withValidatedBody(PushRegistrationSchema, async (req: NextRequest, { params }: Ctx, body) => {
        const ctx = await getTenantCtx(await params, req);

        if ('deviceToken' in body) {
            const sub = await saveApnsRegistration(ctx, {
                deviceToken: body.deviceToken,
                // Passed through as the lower-case wire value; the usecase owns
                // the mapping to the column's enum — #1764 step 3.
                environment: body.environment,
                userAgent: req.headers.get('user-agent'),
            });
            // INFO, and the hint says what is true now. This was a WARN
            // reading "APNs delivery is not implemented yet (#1764 step 3)",
            // which stopped being true when `src/lib/notifications/apns.ts`
            // landed and a key was installed — and it was read in production
            // during the first real TestFlight registration on 2026-10-21,
            // where it says the opposite of the facts. A warning that names a
            // missing capability the product has sends whoever reads it
            // looking in the wrong place, which is worse than no line at all.
            logger.info('push.apns_registered', {
                component: 'push',
                tenantId: ctx.tenantId,
                subscriptionId: sub.id,
                // The environment decides the host, and a null here is the one
                // state the sender refuses rather than guesses — so it is worth
                // having on the registration line rather than inferred later.
                environment: body.environment,
            });
            return jsonResponse({ id: sub.id }, { status: 201 });
        }

        if (!isWebPushConfigured()) {
            return jsonResponse({ error: 'push_not_configured' }, { status: 503 });
        }
        const sub = await savePushSubscription(ctx, {
            endpoint: body.endpoint,
            p256dh: body.keys.p256dh,
            auth: body.keys.auth,
            userAgent: req.headers.get('user-agent'),
        });
        return jsonResponse({ id: sub.id }, { status: 201 });
    }),
);

export const DELETE = withApiErrorHandling(
    withValidatedBody(RemovePushRegistrationSchema, async (req: NextRequest, { params }: Ctx, body) => {
        const ctx = await getTenantCtx(await params, req);
        if ('deviceToken' in body) {
            await removeApnsRegistration(ctx, body.deviceToken);
        } else {
            await removePushSubscription(ctx, body.endpoint);
        }
        return jsonResponse({ ok: true });
    }),
);
