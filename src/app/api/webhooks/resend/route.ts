/**
 * Resend delivery events — the half of #1753 that logging cannot do.
 *
 * ## Why an endpoint rather than more logging
 *
 * `sendEmail` now records what the provider ACCEPTED (#1759). That is not what
 * arrived. Delivery is asynchronous: the send resolves before the receiving
 * server has decided, and a bounce comes back minutes later.
 *
 * Measured on 2026-10-13, four times in one evening. Three DSA Art 16 alerts
 * resolved successfully, `notice-triage-alert` stamped `alertedAt` on each, and
 * all three bounced — `550 … the account or domain may not exist`. The product
 * knew nothing; diagnosing it took a Resend API call from inside the running
 * container. The fourth delivered only after the operator repointed the
 * address, and the difference was invisible from inside either way.
 *
 * So no call-site change could have caught it. The provider has to tell us.
 *
 * ## Shape follows the two existing signed webhooks
 *
 * A bare `POST` export, outside `withApiErrorHandling` — the same as
 * `/api/stripe/webhook` and `/api/storage/av-webhook`, and for a reason worth
 * stating: that wrapper applies the mutation rate limiter, and throttling a
 * provider's delivery feed would drop exactly the notifications this endpoint
 * exists to receive. Resend controls the volume, not a caller we are defending
 * against.
 *
 * It is in `PUBLIC_PATH_EXACT` because the Edge cannot authenticate it —
 * `getToken()` understands only a NextAuth cookie — and it self-authenticates
 * by signature instead. That is the Epic C.1a/b/c contract, and both halves are
 * required: #1745 is what happens when a route is argued public and never
 * added, and an opened prefix with no handler check is the inverse.
 *
 * ## The raw body is the signed input
 *
 * `req.text()`, never `req.json()`, and verification before parsing. The
 * signature covers the bytes, so any reserialisation invalidates it — the same
 * constraint the Stripe route records.
 *
 * ## What it does NOT do yet
 *
 * It makes a failure VISIBLE. It does not yet undo one: linking a bounce back
 * to the `ContentReport` whose alert it was needs outbound message ids
 * persisted against what sent them, so `alertedAt` can be cleared and the next
 * run retries. That is a schema change and its own issue — half-building it
 * here would leave a correlation nobody can rely on.
 */
import { NextRequest } from 'next/server';

import { logger } from '@/lib/observability/logger';
import { jsonResponse } from '@/lib/api-response';
import { env } from '@/env';
import { verifyResendSignature, parseDeliveryEvent } from '@/lib/email/resend-webhook';

export async function POST(req: NextRequest) {
    const rawBody = await req.text();

    const verdict = verifyResendSignature({
        rawBody,
        svixId: req.headers.get('svix-id'),
        svixTimestamp: req.headers.get('svix-timestamp'),
        svixSignature: req.headers.get('svix-signature'),
        // `env`, not `process.env`. `tests/unit/no-fallbacks.test.ts` forbids a
        // bare `process.env` read anywhere in `src/`, and the AV webhook's
        // allowlisted reason for having one ("must run before env validation")
        // does not apply here: nothing on this path runs before startup
        // validation, and the schema already declares this key optional, so
        // an absent secret reaches the `no-secret` branch rather than throwing.
        secret: env.RESEND_WEBHOOK_SECRET,
    });

    if (!verdict.ok) {
        // `no-secret` is 503 and the rest 401, because they are different
        // operator problems: one means this deployment has not configured the
        // feed, the other means something is posting to it that cannot sign.
        // Collapsing them would hide an unconfigured endpoint behind what
        // looks like an attack.
        const status = verdict.reason === 'no-secret' ? 503 : 401;
        logger.warn('mail.webhook_rejected', {
            component: 'resend-webhook',
            reason: verdict.reason,
            status,
        });
        return jsonResponse({ error: verdict.reason }, { status });
    }

    let payload: unknown;
    try {
        payload = JSON.parse(rawBody);
    } catch {
        return jsonResponse({ error: 'invalid-json' }, { status: 400 });
    }

    const event = parseDeliveryEvent(payload);
    if (!event) return jsonResponse({ ok: true, ignored: 'unparseable' }, { status: 200 });

    if (event.isFailure) {
        // ERROR level, because this is the signal whose absence cost an
        // evening. `messageId` is the handle `mail.sent` already logs, so the
        // two lines join: one says what was accepted, this says what happened
        // to it.
        //
        // Recipient DOMAIN only, never the address — Epic C.4, and the reason
        // is sharper here than usual: a bounce feed naming addresses would
        // turn the log into a record of who was invited, who reported what,
        // and who asked to be deleted.
        logger.error('mail.bounced', {
            component: 'resend-webhook',
            event: event.type,
            messageId: event.messageId,
            recipientDomain: event.recipientDomain,
            reason: event.reason,
        });
    } else {
        logger.info('mail.delivery_event', {
            component: 'resend-webhook',
            event: event.type,
            messageId: event.messageId,
            recipientDomain: event.recipientDomain,
        });
    }

    // 200 for every verified event, including ones this does not act on.
    // A non-2xx makes Resend retry, and retrying an event we deliberately
    // ignore is load with no outcome.
    return jsonResponse({ ok: true }, { status: 200 });
}
