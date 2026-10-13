/**
 * Resend delivery events are verified before they are believed (#1753).
 *
 * ## Why this endpoint exists at all
 *
 * A message can be ACCEPTED by the provider, logged as sent, and never arrive.
 * Measured four times on 2026-10-13: three DSA Art 16 alerts resolved
 * successfully, `alertedAt` was stamped on each, and all three bounced minutes
 * later. No call-site logging can catch that, because delivery is
 * asynchronous — the provider has to tell us.
 *
 * ## The signatures here are REAL, not fixtures
 *
 * Every valid case computes its signature the way Svix does —
 * `base64(HMAC-SHA256(key, "<id>.<ts>.<body>"))` with the key being the
 * base64-decoded secret after `whsec_`. A hand-written fixture would only
 * prove the verifier agrees with my reading of the spec; computing it means a
 * wrong implementation cannot pass by my having mis-copied the same thing
 * twice.
 */
import crypto from 'crypto';

import {
    verifyResendSignature,
    parseDeliveryEvent,
    SVIX_TOLERANCE_SECONDS,
} from '@/lib/email/resend-webhook';

const SECRET = `whsec_${Buffer.from('a-test-signing-key-32-bytes-long').toString('base64')}`;
const ID = 'msg_2abc';
const BODY = JSON.stringify({ type: 'email.bounced', data: { email_id: 'e1', to: ['x@y.test'] } });

function sign(body: string, ts: number, secret = SECRET, id = ID): string {
    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    return crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
}

const NOW = 1_760_000_000;

describe('a genuine Resend signature is accepted', () => {
    it('accepts a correctly signed body', () => {
        const ts = NOW;
        const v = verifyResendSignature({
            rawBody: BODY, svixId: ID, svixTimestamp: String(ts),
            svixSignature: `v1,${sign(BODY, ts)}`, secret: SECRET, nowSeconds: NOW,
        });
        expect(v).toEqual({ ok: true });
    });

    it('accepts when several versioned signatures are present', () => {
        // Svix sends more than one during a secret rotation. Refusing the set
        // because one entry is unknown would break the rotation it exists for.
        const ts = NOW;
        const v = verifyResendSignature({
            rawBody: BODY, svixId: ID, svixTimestamp: String(ts),
            svixSignature: `v0,ignored v1,${sign(BODY, ts)} v2,future`,
            secret: SECRET, nowSeconds: NOW,
        });
        expect(v).toEqual({ ok: true });
    });
});

describe('anything else is refused', () => {
    it('refuses a body altered after signing — THE point of the signature', () => {
        const ts = NOW;
        const sig = sign(BODY, ts);
        const v = verifyResendSignature({
            rawBody: BODY.replace('email.bounced', 'email.delivered'),
            svixId: ID, svixTimestamp: String(ts),
            svixSignature: `v1,${sig}`, secret: SECRET, nowSeconds: NOW,
        });
        expect(v).toEqual({ ok: false, reason: 'bad-signature' });
    });

    it('refuses a signature made with a different secret', () => {
        const ts = NOW;
        const other = `whsec_${Buffer.from('a-different-key-of-the-same-size').toString('base64')}`;
        const v = verifyResendSignature({
            rawBody: BODY, svixId: ID, svixTimestamp: String(ts),
            svixSignature: `v1,${sign(BODY, ts, other)}`, secret: SECRET, nowSeconds: NOW,
        });
        expect(v).toEqual({ ok: false, reason: 'bad-signature' });
    });

    it('refuses a signature bound to a different message id', () => {
        // The id is part of the signed content, so a valid delivery cannot be
        // replayed under a new id.
        const ts = NOW;
        const v = verifyResendSignature({
            rawBody: BODY, svixId: 'msg_other', svixTimestamp: String(ts),
            svixSignature: `v1,${sign(BODY, ts, SECRET, ID)}`, secret: SECRET, nowSeconds: NOW,
        });
        expect(v).toEqual({ ok: false, reason: 'bad-signature' });
    });

    it('refuses a STALE timestamp, so a captured delivery is not replayable', () => {
        // Without a freshness bound a captured request is valid for ever.
        // Once the correlation half lands, a replayed bounce would make the
        // platform retry a send on demand.
        const ts = NOW - SVIX_TOLERANCE_SECONDS - 1;
        const v = verifyResendSignature({
            rawBody: BODY, svixId: ID, svixTimestamp: String(ts),
            svixSignature: `v1,${sign(BODY, ts)}`, secret: SECRET, nowSeconds: NOW,
        });
        expect(v).toEqual({ ok: false, reason: 'stale' });
    });

    it('refuses a FUTURE timestamp too, not only an old one', () => {
        const ts = NOW + SVIX_TOLERANCE_SECONDS + 1;
        const v = verifyResendSignature({
            rawBody: BODY, svixId: ID, svixTimestamp: String(ts),
            svixSignature: `v1,${sign(BODY, ts)}`, secret: SECRET, nowSeconds: NOW,
        });
        expect(v).toEqual({ ok: false, reason: 'stale' });
    });

    it('refuses when no secret is configured — unconfigured is not a pass', () => {
        // The endpoint is public. With no secret there is nothing separating
        // Resend from anyone who finds the URL, so it must refuse rather than
        // believe the body.
        const v = verifyResendSignature({
            rawBody: BODY, svixId: ID, svixTimestamp: String(NOW),
            svixSignature: 'v1,anything', secret: undefined, nowSeconds: NOW,
        });
        expect(v).toEqual({ ok: false, reason: 'no-secret' });
    });

    it.each(['svixId', 'svixTimestamp', 'svixSignature'])('refuses with %s missing', (field) => {
        const ts = NOW;
        const base = {
            rawBody: BODY, svixId: ID as string | null, svixTimestamp: String(ts) as string | null,
            svixSignature: `v1,${sign(BODY, ts)}` as string | null,
            secret: SECRET, nowSeconds: NOW,
        };
        const v = verifyResendSignature({ ...base, [field]: null });
        expect(v).toEqual({ ok: false, reason: 'missing-headers' });
    });

    it('refuses a signature of the right shape but wrong length without throwing', () => {
        // `timingSafeEqual` THROWS on unequal lengths. An unguarded compare
        // would turn a malformed header into a 500 — and a public endpoint
        // that can be crashed by a header is worse than one that refuses.
        const v = verifyResendSignature({
            rawBody: BODY, svixId: ID, svixTimestamp: String(NOW),
            svixSignature: 'v1,dG9vLXNob3J0', secret: SECRET, nowSeconds: NOW,
        });
        expect(v).toEqual({ ok: false, reason: 'bad-signature' });
    });
});

describe('what the parser extracts, and what it refuses to', () => {
    it('reads the message id, the DOMAIN and a bounded reason', () => {
        const e = parseDeliveryEvent({
            type: 'email.bounced',
            data: {
                email_id: 'abc-123',
                to: ['someone@example.test'],
                bounce: { type: 'Transient', subType: 'General' },
            },
        });
        expect(e).toEqual({
            type: 'email.bounced',
            messageId: 'abc-123',
            recipientDomain: 'example.test',
            reason: 'Transient/General',
            isFailure: true,
        });
    });

    it('NEVER carries the address itself', () => {
        // Epic C.4. A bounce feed naming addresses turns the log into a record
        // of who was invited, who reported what, and who asked to be deleted.
        const e = parseDeliveryEvent({
            type: 'email.bounced',
            data: { email_id: 'x', to: ['dsa@agrent.bg'] },
        });
        expect(JSON.stringify(e)).not.toContain('dsa@');
        expect(e!.recipientDomain).toBe('agrent.bg');
    });

    it('marks delivered events as NOT failures', () => {
        const e = parseDeliveryEvent({ type: 'email.delivered', data: { email_id: 'x', to: ['a@b.test'] } });
        expect(e!.isFailure).toBe(false);
    });

    it.each(['email.bounced', 'email.complained', 'email.failed'])('%s IS a failure', (type) => {
        const e = parseDeliveryEvent({ type, data: { email_id: 'x', to: ['a@b.test'] } });
        expect({ type, isFailure: e!.isFailure }).toEqual({ type, isFailure: true });
    });

    it('survives a payload with no data at all', () => {
        // A provider changing its shape must not crash a public endpoint.
        expect(parseDeliveryEvent({ type: 'email.bounced' })).toMatchObject({
            messageId: null, recipientDomain: null, isFailure: true,
        });
        expect(parseDeliveryEvent(null)).toBeNull();
        expect(parseDeliveryEvent({})).toBeNull();
    });
});
