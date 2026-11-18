import { NextRequest, NextResponse } from 'next/server';
import { constructWebhookEvent, handleWebhookEvent } from '@/lib/stripe';
import { logger } from '@/lib/observability/logger';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/stripe/webhook
 * Stripe webhook endpoint. Public (no auth), but verifies signature.
 *
 * IMPORTANT: This route must NOT parse body as JSON — Stripe signature
 * verification requires the raw body text.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
    const signature = req.headers.get('stripe-signature');
    if (!signature) {
        return jsonResponse({ error: 'Missing stripe-signature header' }, { status: 400 });
    }

    let event;
    try {
        const body = await req.text();
        event = constructWebhookEvent(body, signature);
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid signature';
        logger.error('Stripe webhook signature verification failed', { component: 'stripe', error: message });
        return jsonResponse({ error: `Webhook signature verification failed: ${message}` }, { status: 400 });
    }

    try {
        await handleWebhookEvent(event);
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error('Stripe webhook event processing failed', { component: 'stripe', error: message });
        // 500, so Stripe RETRIES (#3182). This answered 200 "to prevent Stripe
        // from retrying", which turned any transient failure — a database
        // blip, pool exhaustion, the `subscriptions.retrieve` call inside
        // checkout — into a lost state transition with no reconciliation: a
        // paying farm left PAST_DUE and restricted 14 days later, a cancelled
        // one left on its paid plan. Stripe's redelivery is the only recovery
        // there is, and a retry is safe: `handleWebhookEvent` skips an event
        // id it has already recorded, and records it only after the account
        // write it describes. The body carries no error detail.
        return jsonResponse({ error: 'processing_failed' }, { status: 500 });
    }

    return jsonResponse({ received: true });
}
