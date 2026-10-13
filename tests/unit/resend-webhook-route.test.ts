/**
 * `POST /api/webhooks/resend` — the handler, not the verifier (#1753).
 *
 * `resend-webhook-verification.test.ts` proves the signature maths. This
 * proves the three things the ROUTE decides, each of which the maths cannot:
 *
 *   1. **Verification happens on the raw bytes, before parsing.** The
 *      signature covers what was sent, so any reserialisation invalidates it.
 *      Asserted by signing a body that is NOT valid JSON and showing it gets
 *      400 rather than 401 — the only way to reach the parse failure is to
 *      have passed verification first, so the ordering is observable rather
 *      than asserted by inspection.
 *   2. **`no-secret` and a bad signature are different operator problems.**
 *      503 vs 401: one says this deployment never configured the feed, the
 *      other says something is posting to it that cannot sign. Collapsed,
 *      an unconfigured endpoint hides behind what looks like an attack.
 *   3. **A verified event always ends 200**, including one it ignores — a
 *      non-2xx makes Resend retry, and retrying a deliberately-ignored event
 *      is load with no outcome.
 */
import crypto from 'crypto';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('@/lib/observability/logger', () => ({
    ...jest.requireActual('@/lib/observability/logger'),
    logger,
}));

import { NextRequest } from 'next/server';

import { POST } from '@/app/api/webhooks/resend/route';

const SECRET = `whsec_${Buffer.from('route-test-signing-key-32-bytes!').toString('base64')}`;
const ID = 'msg_route';

function sign(body: string, ts: number, secret = SECRET): string {
    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    return crypto.createHmac('sha256', key).update(`${ID}.${ts}.${body}`).digest('base64');
}

/** A real `NextRequest`, so `req.text()` and `req.headers` behave as in production. */
function post(body: string, headers: Record<string, string>): NextRequest {
    return new NextRequest('https://app.agrent.bg/api/webhooks/resend', {
        method: 'POST',
        body,
        headers,
    });
}

/** Correctly signed, with a timestamp inside the tolerance window. */
function signed(body: string): NextRequest {
    const ts = Math.floor(Date.now() / 1000);
    return post(body, {
        'svix-id': ID,
        'svix-timestamp': String(ts),
        'svix-signature': `v1,${sign(body, ts)}`,
    });
}

const BOUNCE = JSON.stringify({
    type: 'email.bounced',
    data: { email_id: 'mid-1', to: ['someone@example.test'], bounce: { type: 'Permanent' } },
});

let savedSecret: string | undefined;

beforeEach(() => {
    savedSecret = process.env.RESEND_WEBHOOK_SECRET;
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
});

afterEach(() => {
    if (savedSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
    else process.env.RESEND_WEBHOOK_SECRET = savedSecret;
});

describe('a signed bounce is recorded', () => {
    it('answers 200 and logs mail.bounced at ERROR', async () => {
        const res = await POST(signed(BOUNCE));

        expect(res.status).toBe(200);
        // ERROR, not warn: this is the signal whose absence cost an evening on
        // 2026-10-13, when three DSA Art 16 alerts were stamped as alerted and
        // all three bounced.
        expect(logger.error).toHaveBeenCalledWith('mail.bounced', expect.any(Object));
    });

    it('logs the message id, so it JOINS the mail.sent line', async () => {
        await POST(signed(BOUNCE));

        const meta = logger.error.mock.calls[0][1] as Record<string, unknown>;
        // `mail.sent` (#1759) logs this same id at accept time. The pair is
        // what makes a bounce traceable to what sent it; without the id the
        // line says only that something, somewhere, failed.
        expect(meta.messageId).toBe('mid-1');
        expect(meta.event).toBe('email.bounced');
    });

    it('logs the recipient DOMAIN and never the address', async () => {
        await POST(signed(BOUNCE));

        const meta = logger.error.mock.calls[0][1] as Record<string, unknown>;
        expect(meta.recipientDomain).toBe('example.test');
        // Epic C.4, and sharper here than usual: a bounce feed naming
        // addresses turns the log into a record of who was invited, who
        // reported what, and who asked to be deleted.
        expect(JSON.stringify(meta)).not.toContain('someone@');
    });

    it('a DELIVERED event is info, not error', async () => {
        await POST(signed(JSON.stringify({
            type: 'email.delivered', data: { email_id: 'mid-2', to: ['a@b.test'] },
        })));

        // The negative control for the pair above: if every verified event
        // logged at error, the bounce assertions would pass with the
        // failure/success distinction deleted.
        expect(logger.error).not.toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledWith('mail.delivery_event', expect.any(Object));
    });
});

describe('verification happens on the RAW bytes, before parsing', () => {
    it('a correctly signed body that is not JSON reaches the parser (400)', async () => {
        // Establishes only that the parse refusal is REACHABLE. On its own it
        // does not pin the ordering — see the next case.
        const res = await POST(signed('not-json-at-all'));

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'invalid-json' });
    });

    it('an UNSIGNED body that is not JSON is 401, never 400', async () => {
        // THE ordering assertion, and the case above is not it.
        //
        // Measured: moving the `JSON.parse` block above the verification left
        // all 13 cases green, because a body that is signed AND unparseable
        // answers 400 in BOTH orderings. The input that distinguishes them is
        // one that fails BOTH checks — verify-first refuses it 401, parse-first
        // answers 400 and has thereby told an unauthenticated caller
        // something about a body it was never entitled to have read.
        //
        // That is the security property, not merely a tidiness one: the first
        // thing this endpoint does to an unauthenticated byte string must be
        // to reject it.
        const res = await POST(post('not-json-at-all', {
            'svix-id': ID,
            'svix-timestamp': String(Math.floor(Date.now() / 1000)),
            'svix-signature': 'v1,bm90LXRoZS1yaWdodC1zaWduYXR1cmUtYXQtYWxs',
        }));

        expect(res.status).toBe(401);
        expect(res.status).not.toBe(400);
    });

    it('a body RESERIALISED after signing is refused', async () => {
        // Semantically identical JSON, different bytes. A handler verifying a
        // re-encoded body would accept this, and would then accept a payload
        // an attacker had re-encoded with different contents.
        const ts = Math.floor(Date.now() / 1000);
        // Whitespace, so reserialisation genuinely changes the bytes. My first
        // version used canonical compact JSON, `JSON.stringify(JSON.parse(x))`
        // returned it unchanged, and the premise assertion below failed — the
        // case would otherwise have "passed" while testing nothing.
        const original = '{"type": "email.bounced", "data": {"email_id": "m"}}';
        const reserialised = JSON.stringify(JSON.parse(original) as unknown);
        expect(reserialised).not.toBe(original); // the premise of the case

        const res = await POST(post(reserialised, {
            'svix-id': ID,
            'svix-timestamp': String(ts),
            'svix-signature': `v1,${sign(original, ts)}`,
        }));

        expect(res.status).toBe(401);
    });
});

describe('the two refusals are told apart', () => {
    it('no configured secret is 503 — an operator problem, not an attacker', async () => {
        delete process.env.RESEND_WEBHOOK_SECRET;

        const res = await POST(signed(BOUNCE));

        expect(res.status).toBe(503);
        expect(logger.warn).toHaveBeenCalledWith(
            'mail.webhook_rejected',
            expect.objectContaining({ reason: 'no-secret' }),
        );
    });

    it('a bad signature is 401', async () => {
        const ts = Math.floor(Date.now() / 1000);
        const res = await POST(post(BOUNCE, {
            'svix-id': ID,
            'svix-timestamp': String(ts),
            'svix-signature': 'v1,bm90LXRoZS1yaWdodC1zaWduYXR1cmUtYXQtYWxs',
        }));

        expect(res.status).toBe(401);
        // And it does NOT act on the body it refused.
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('a request with no svix headers at all is 401, not 500', async () => {
        const res = await POST(post(BOUNCE, {}));

        expect(res.status).toBe(401);
    });

    it('503 and 401 are DISTINCT — the whole point of splitting them', async () => {
        const ts = Math.floor(Date.now() / 1000);
        const bad = () => post(BOUNCE, {
            'svix-id': ID, 'svix-timestamp': String(ts), 'svix-signature': 'v1,d3Jvbmc=',
        });

        const withSecret = await POST(bad());
        delete process.env.RESEND_WEBHOOK_SECRET;
        const without = await POST(bad());

        // Asserted as a difference as well as two values: a handler returning
        // one status for both causes would satisfy either case above read on
        // its own, and an unconfigured endpoint would be indistinguishable
        // from someone probing it.
        expect(withSecret.status).not.toBe(without.status);
        expect([withSecret.status, without.status]).toEqual([401, 503]);
    });
});

describe('a verified event always ends 200', () => {
    it.each([
        ['an event type nobody handles', { type: 'email.opened', data: { email_id: 'x', to: ['a@b.test'] } }],
        ['a payload with no data', { type: 'email.bounced' }],
        ['a shape with no type at all', { data: { email_id: 'x' } }],
    ])('%s still answers 200', async (_label, payload) => {
        const res = await POST(signed(JSON.stringify(payload)));

        // Not an error: a non-2xx makes Resend retry, and retrying an event we
        // deliberately ignore is load with no outcome. A provider changing its
        // payload shape must not turn into a retry storm.
        expect(res.status).toBe(200);
    });
});
