/**
 * #3182 — a Stripe event that fails to process is answered 5xx, so Stripe
 * redelivers it.
 *
 * It was answered 200 "to prevent Stripe from retrying", which made any
 * transient failure a lost billing transition with no reconciliation.
 */
import { NextRequest } from 'next/server';

const handleWebhookEvent = jest.fn();
jest.mock('@/lib/stripe', () => ({
    constructWebhookEvent: () => ({ id: 'evt_1', type: 'invoice.payment_succeeded' }),
    handleWebhookEvent: (...a: unknown[]) => handleWebhookEvent(...a),
}));

import { POST } from '@/app/api/stripe/webhook/route';

function req() {
    return new NextRequest('http://localhost/api/stripe/webhook', {
        method: 'POST',
        headers: { 'stripe-signature': 't=1,v1=x' },
        body: '{}',
    });
}

describe('POST /api/stripe/webhook (#3182)', () => {
    beforeEach(() => handleWebhookEvent.mockReset());

    it('answers 500 when processing throws, so Stripe retries', async () => {
        handleWebhookEvent.mockRejectedValue(new Error('pool exhausted'));
        const res = await POST(req());
        expect(res.status).toBe(500);
        // No internal detail in the body.
        expect(JSON.stringify(await res.json())).not.toContain('pool exhausted');
    });

    it('control: answers 200 when processing succeeds', async () => {
        handleWebhookEvent.mockResolvedValue(undefined);
        const res = await POST(req());
        expect(res.status).toBe(200);
    });
});
