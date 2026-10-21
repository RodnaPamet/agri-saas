/**
 * A phone can register for push (#1764, step 2).
 *
 * ## What was impossible before
 *
 * `POST /api/t/{tenantSlug}/push-subscriptions` was the only device
 * registration surface and modelled a W3C PushSubscription exclusively: an
 * https `endpoint` plus `p256dh`/`auth`. An APNs device token is 64 hex
 * characters, so it failed `httpsUrl()` at the schema. There was no way for
 * the native client to register and no way for the server to address a phone
 * (agrent-ios#272).
 *
 * ## The trap this suite exists for
 *
 * The route answered `503 push_not_configured` whenever `isWebPushConfigured()`
 * was false — VAPID keys gating the WHOLE endpoint. Left that way, an iPhone
 * registering a token would have been refused by a check about a key it does
 * not use, and the refusal would have looked like a server fault to a client
 * that had done everything right. So the 503 is asserted to be
 * transport-specific, in both directions.
 *
 * ## And the honest gap
 *
 * A token is accepted while nothing sends to it — the transport is step 3 and
 * needs a production key. That is deliberate, and the WARN log is what keeps
 * it from being invisible. Asserted here, because "wired is not delivered"
 * only stays honest if the difference is legible to an operator.
 */
const getTenantCtx = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...a: unknown[]) => getTenantCtx(...a),
}));

const isWebPushConfigured = jest.fn();
jest.mock('@/lib/notifications/web-push', () => ({
    isWebPushConfigured: () => isWebPushConfigured(),
}));

const saveApnsRegistration = jest.fn();
const removeApnsRegistration = jest.fn();
const savePushSubscription = jest.fn();
const removePushSubscription = jest.fn();
jest.mock('@/app-layer/usecases/push-subscription', () => ({
    saveApnsRegistration: (...a: unknown[]) => saveApnsRegistration(...a),
    removeApnsRegistration: (...a: unknown[]) => removeApnsRegistration(...a),
    savePushSubscription: (...a: unknown[]) => savePushSubscription(...a),
    removePushSubscription: (...a: unknown[]) => removePushSubscription(...a),
}));

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('@/lib/observability/logger', () => ({
    ...jest.requireActual('@/lib/observability/logger'),
    logger,
}));

import { NextRequest } from 'next/server';

import { POST, DELETE } from '@/app/api/t/[tenantSlug]/push-subscriptions/route';
import {
    ApnsRegistrationSchema,
    PushRegistrationSchema,
    PushSubscriptionSchema,
} from '@/app-layer/schemas/push.schemas';

const TOKEN = 'a3f'.padEnd(64, '0').slice(0, 64);
const WEB_BODY = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(20) },
};

function req(body: unknown): NextRequest {
    return new NextRequest('https://app.agrent.bg/api/t/acme/push-subscriptions', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', 'user-agent': 'agrent-ios/1.0' },
    });
}

const CTX = { params: Promise.resolve({ tenantSlug: 'acme' }) };

beforeEach(() => {
    jest.clearAllMocks();
    getTenantCtx.mockResolvedValue({ tenantId: 't-1', userId: 'u-1', tenantSlug: 'acme' });
    isWebPushConfigured.mockReturnValue(true);
    saveApnsRegistration.mockResolvedValue({ id: 'ps-ios' });
    savePushSubscription.mockResolvedValue({ id: 'ps-web' });
});

describe('an APNs token registers', () => {
    it('answers 201 and stores the token', async () => {
        const res = await POST(req({ platform: 'IOS', deviceToken: TOKEN }), CTX);

        expect(res.status).toBe(201);
        expect(saveApnsRegistration).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ deviceToken: TOKEN }),
        );
        // The web path must not be touched — the two usecases write different
        // column sets and a row with both is refused by the CHECK.
        expect(savePushSubscription).not.toHaveBeenCalled();
    });

    it('is NOT gated by the Web Push VAPID keys', async () => {
        // THE trap. A key the iPhone does not use must not refuse it.
        isWebPushConfigured.mockReturnValue(false);

        const res = await POST(req({ platform: 'IOS', deviceToken: TOKEN }), CTX);

        expect(res.status).toBe(201);
        expect(saveApnsRegistration).toHaveBeenCalled();
    });

    it('logs the registration at INFO, with the environment that decides the host', async () => {
        // This asserted `push.apns_registered_without_transport` at WARN,
        // whose hint read "APNs delivery is not implemented yet (#1764 step
        // 3)" — accurate when written and false from the moment `apns.ts`
        // landed. It was read in production during the first real TestFlight
        // registration, where it said the opposite of the facts: a warning
        // naming a missing capability the product has sends whoever reads it
        // looking in the wrong place.
        //
        // The case name went with it. "logs that nothing can send to it yet"
        // encoded the stale claim as the thing being proved, so the test would
        // have gone on passing about a world that no longer existed.
        //
        // `environment` rather than a hint, because it is the field that picks
        // the host and the one value the sender refuses rather than guesses —
        // worth having on the registration line instead of inferred later.
        await POST(
            req({ platform: 'IOS', deviceToken: TOKEN, environment: 'production' }),
            CTX,
        );

        expect(logger.info).toHaveBeenCalledWith(
            'push.apns_registered',
            expect.objectContaining({ component: 'push', environment: 'production' }),
        );
        expect(logger.warn).not.toHaveBeenCalledWith(
            'push.apns_registered_without_transport',
            expect.anything(),
        );
    });

    it('passes the user agent through, so a device is identifiable later', async () => {
        await POST(req({ platform: 'IOS', deviceToken: TOKEN }), CTX);

        expect(saveApnsRegistration).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ userAgent: 'agrent-ios/1.0' }),
        );
    });

    describe('the APNs environment — #1764 step 3', () => {
        it('passes the wire value through unchanged', async () => {
            // Lower-case on the wire, because that is what `aps-environment`
            // in the provisioning profile says. The usecase owns the mapping
            // to the column's enum, so the route must not pre-translate.
            await POST(
                req({ platform: 'IOS', deviceToken: TOKEN, environment: 'development' }),
                CTX,
            );

            expect(saveApnsRegistration).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ environment: 'development' }),
            );
        });

        it('accepts a registration with NO environment — the compatibility case', async () => {
            // The build installed today does not send the field, and a phone
            // that cannot register receives nothing. So absent must be
            // accepted, and reach the usecase as undefined rather than as a
            // guessed value.
            const res = await POST(req({ platform: 'IOS', deviceToken: TOKEN }), CTX);

            expect(res.status).toBe(201);
            const arg = (saveApnsRegistration as jest.Mock).mock.calls.at(-1)?.[1] as Record<
                string,
                unknown
            >;
            expect(arg.environment).toBeUndefined();
        });

        it('REFUSES a value that is neither', async () => {
            // The column is an enum of two members. A third spelling —
            // "sandbox" is the obvious one, since that is what the HOST is
            // called — must fail at the boundary rather than reach the
            // mapping and resolve to undefined there.
            const res = await POST(
                req({ platform: 'IOS', deviceToken: TOKEN, environment: 'sandbox' }),
                CTX,
            );

            expect(res.status).toBe(400);
            expect(saveApnsRegistration).not.toHaveBeenCalled();
        });
    });
});

describe('the web path is unchanged', () => {
    it('still registers a Web Push subscription', async () => {
        const res = await POST(req(WEB_BODY), CTX);

        expect(res.status).toBe(201);
        expect(savePushSubscription).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ endpoint: WEB_BODY.endpoint }),
        );
        expect(saveApnsRegistration).not.toHaveBeenCalled();
    });

    it('still answers 503 when VAPID keys are absent', async () => {
        // The other half of the transport-specific gate. If this regressed to
        // a 201, a browser would believe it was subscribed and silently
        // receive nothing.
        isWebPushConfigured.mockReturnValue(false);

        const res = await POST(req(WEB_BODY), CTX);

        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: 'push_not_configured' });
        expect(savePushSubscription).not.toHaveBeenCalled();
    });

    it('a body with NO platform field still parses — the back-compat control', () => {
        // The shipped web client sends no `platform`. A `z.discriminatedUnion`
        // would read the discriminator out of the input and reject this, which
        // is why the union is a plain one with the web member first.
        expect(PushRegistrationSchema.safeParse(WEB_BODY).success).toBe(true);
        expect(PushSubscriptionSchema.safeParse(WEB_BODY).success).toBe(true);
    });
});

describe('the token is validated, not just accepted', () => {
    it.each([
        ['too short', 'abc'],
        // 65 hex was "too long" while the pin was exactly 64. It is now a
        // VALID length, because Apple documents variable-length tokens and
        // agrent-ios measured an 80-byte one — so the case moves to the new
        // ceiling rather than being deleted. Deleting it would have removed
        // the only assertion that a ceiling exists at all.
        ['past the ceiling', 'a'.repeat(201)],
        ['non-hex', 'g'.repeat(64)],
        ['empty', ''],
        ['a url', 'https://api.push.apple.com/3/device/abc'],
    ])('refuses a %s token', (_label, deviceToken) => {
        // The token goes into an HTTP/2 request PATH to Apple, so an
        // unvalidated value is a request-splitting shape at the one field a
        // client controls — the same reasoning that pinned `endpoint`.
        expect(ApnsRegistrationSchema.safeParse({ platform: 'IOS', deviceToken }).success)
            .toBe(false);
    });

    it('accepts a LONGER token than 32 bytes — #1764, measured', () => {
        // Apple documents device tokens as variable length, and agrent-ios
        // measured an 80-byte one (160 hex) on a simulator. The old pin was
        // exactly 64, so such a device would have taken a 400 on every
        // registration — silently, because a phone that cannot register just
        // receives nothing.
        //
        // What the pin exists for is the ALPHABET, not the count: hex admits
        // no slash, CR, LF or space, so there is nothing to interpret as
        // structure in the request path built from it.
        const long = 'ab'.repeat(80); // 160 hex = 80 bytes
        expect(ApnsRegistrationSchema.safeParse({ platform: 'IOS', deviceToken: long }).success)
            .toBe(true);
    });

    it('still REFUSES a non-hex token, and one past the ceiling', () => {
        // The controls. Widening the length must not become accepting
        // anything: a value carrying a path separator is the shape the pin
        // exists to stop, and an unbounded length hands a caller the size of a
        // path we construct.
        for (const bad of [
            `${'ab'.repeat(31)}/x`, // a separator
            `${'ab'.repeat(31)}\r\n`, // CRLF
            'g'.repeat(64), // outside hex
            'ab'.repeat(120), // 240 hex, past the 200 ceiling
            'ab'.repeat(20), // 40 hex, under the floor
        ]) {
            expect(
                ApnsRegistrationSchema.safeParse({ platform: 'IOS', deviceToken: bad }).success,
            ).toBe(false);
        }
    });

    it('accepts upper and lower case hex', () => {
        // Apple's docs and the iOS `Data.description` path differ on case, and
        // a token rejected for being uppercase is a silent registration
        // failure on the client's side.
        for (const t of ['a'.repeat(64), 'A'.repeat(64), `${'a'.repeat(32)}${'B'.repeat(32)}`]) {
            expect(ApnsRegistrationSchema.safeParse({ platform: 'IOS', deviceToken: t }).success)
                .toBe(true);
        }
    });
});

describe('unregistering reaches the right transport', () => {
    it('a token body removes the APNs row only', async () => {
        const res = await DELETE(req({ platform: 'IOS', deviceToken: TOKEN }), CTX);

        expect(res.status).toBe(200);
        expect(removeApnsRegistration).toHaveBeenCalledWith(expect.anything(), TOKEN);
        expect(removePushSubscription).not.toHaveBeenCalled();
    });

    it('an endpoint body removes the Web Push row only', async () => {
        const res = await DELETE(req({ endpoint: WEB_BODY.endpoint }), CTX);

        expect(res.status).toBe(200);
        expect(removePushSubscription).toHaveBeenCalledWith(expect.anything(), WEB_BODY.endpoint);
        expect(removeApnsRegistration).not.toHaveBeenCalled();
    });
});
