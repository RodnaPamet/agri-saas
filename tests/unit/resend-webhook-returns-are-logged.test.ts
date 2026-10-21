/**
 * No path out of the Resend webhook is silent.
 *
 * Two of them were, and the cost was a question nobody could answer. Measured
 * 2026-10-21 over the whole observable window: ZERO entries for every one of
 * this route's log lines, while 19 `mail-canary.sent` events went out in the
 * same period. Three worlds produce that same absence —
 *
 *   1. Resend is not calling the endpoint at all;
 *   2. it calls, and the event shape is one `parseDeliveryEvent` does not
 *      recognise, so the route returned 200 with no trace;
 *   3. it calls, and the body is not JSON, so the route returned 400 with no
 *      trace.
 *
 * — and only the first is benign. Worlds 2 and 3 mean the provider reads
 * success (or a client error it will not retry) while we keep no record that a
 * delivery event ever arrived. These tests are what make the three
 * distinguishable in the next window.
 *
 * `RESEND_WEBHOOK_SECRET` is ABSENT in production as of the same measurement,
 * so the live behaviour today is the 503 `no-secret` branch — which does log,
 * and whose absence is what rules world 1 in.
 */
import { NextRequest } from 'next/server';

const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('@/lib/observability/logger', () => ({ logger }));

const verifyResendSignature = jest.fn();
const parseDeliveryEvent = jest.fn();
jest.mock('@/lib/email/resend-webhook', () => ({
    verifyResendSignature: (...a: unknown[]) => verifyResendSignature(...a),
    parseDeliveryEvent: (...a: unknown[]) => parseDeliveryEvent(...a),
}));

const applyDeliveryFailure = jest.fn();
jest.mock('@/app-layer/notifications/apply-delivery-failure', () => ({
    applyDeliveryFailure: (...a: unknown[]) => applyDeliveryFailure(...a),
}));

jest.mock('@/env', () => ({ env: { RESEND_WEBHOOK_SECRET: 'whsec_test' } }));

import { POST } from '@/app/api/webhooks/resend/route';

function post(body: string) {
    return POST(
        new NextRequest('http://localhost:3000/api/webhooks/resend', {
            method: 'POST',
            body,
            headers: {
                'svix-id': 'msg_1',
                'svix-timestamp': '1',
                'svix-signature': 'v1,sig',
            },
        }),
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    verifyResendSignature.mockReturnValue({ ok: true });
});

describe('a body that is not JSON', () => {
    // Break: a SIGNED body the parser cannot read means the signature and the
    // parser disagree about what was sent. Returning 400 silently loses that.
    it('logs and still refuses with 400', async () => {
        const res = await post('not json at all');
        expect(res.status).toBe(400);
        expect(logger.warn).toHaveBeenCalledWith(
            'mail.webhook_unreadable',
            expect.objectContaining({ reason: 'invalid-json' }),
        );
    });

    it('logs the body LENGTH and never the body', async () => {
        await post('{"to":"farmer@example.bg"');
        const [, meta] = logger.warn.mock.calls[0]!;
        expect(meta).toHaveProperty('bodyBytes');
        // A provider payload carries recipient addresses. The whole point of
        // logging a length is that it is not the content.
        expect(JSON.stringify(meta)).not.toContain('farmer@example.bg');
    });
});

describe('an event shape the parser does not recognise', () => {
    // Break: THE silent one. 200 with no log means the provider reads success
    // and never retries, and we keep no record that it called — so "never
    // called" and "called with a shape we cannot read" are the same absence.
    it('logs a warning and still answers 200', async () => {
        parseDeliveryEvent.mockReturnValue(null);
        const res = await post(JSON.stringify({ type: 'email.opened', data: {} }));
        expect(res.status).toBe(200);
        expect(logger.warn).toHaveBeenCalledWith(
            'mail.webhook_unparsed_event',
            expect.objectContaining({ eventType: 'email.opened', hasType: true }),
        );
    });

    it('echoes the event TYPE, because that names what to teach the parser', async () => {
        parseDeliveryEvent.mockReturnValue(null);
        await post(JSON.stringify({ type: 'email.delivery_delayed' }));
        const [, meta] = logger.warn.mock.calls[0]!;
        expect(meta).toMatchObject({ eventType: 'email.delivery_delayed' });
    });

    it('says so when the payload has no type at all', async () => {
        parseDeliveryEvent.mockReturnValue(null);
        await post(JSON.stringify({ nothing: true }));
        expect(logger.warn).toHaveBeenCalledWith(
            'mail.webhook_unparsed_event',
            expect.objectContaining({ eventType: null, hasType: false }),
        );
    });

    it('logs no recipient from an unparsed payload', async () => {
        parseDeliveryEvent.mockReturnValue(null);
        await post(JSON.stringify({ type: 'x', data: { to: ['farmer@example.bg'] } }));
        const [, meta] = logger.warn.mock.calls[0]!;
        expect(JSON.stringify(meta)).not.toContain('farmer@example.bg');
    });

    it('does not invoke the failure path for an event it could not read', async () => {
        parseDeliveryEvent.mockReturnValue(null);
        await post(JSON.stringify({ type: 'x' }));
        expect(applyDeliveryFailure).not.toHaveBeenCalled();
    });
});

describe('the paths that already logged still do', () => {
    it('an unsigned call is rejected and logged', async () => {
        verifyResendSignature.mockReturnValue({ ok: false, reason: 'bad-signature' });
        const res = await post('{}');
        expect(res.status).toBe(401);
        expect(logger.warn).toHaveBeenCalledWith(
            'mail.webhook_rejected',
            expect.objectContaining({ reason: 'bad-signature', status: 401 }),
        );
    });

    // Break: this is the branch production is in TODAY — the secret is unset,
    // so every call 503s. Its log line is what rules out "Resend is calling
    // and being turned away", so it must stay distinct from a 401.
    it('an unconfigured secret is 503, not 401, and logged', async () => {
        verifyResendSignature.mockReturnValue({ ok: false, reason: 'no-secret' });
        const res = await post('{}');
        expect(res.status).toBe(503);
        expect(logger.warn).toHaveBeenCalledWith(
            'mail.webhook_rejected',
            expect.objectContaining({ reason: 'no-secret', status: 503 }),
        );
    });
});
