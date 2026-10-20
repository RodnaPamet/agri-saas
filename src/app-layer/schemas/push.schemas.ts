import { z } from 'zod';
import { httpsUrl } from '@/lib/schemas/url';
import { checkPushEndpoint } from '@/app-layer/automation/webhook-safety';

/**
 * Web Push subscription as produced by `PushSubscription.toJSON()`.
 *
 * ## Why the endpoint is pinned, when #667 flagged it as risky to tighten
 *
 * The stated worry was the false-negative: reject one real push service and a
 * device silently stops receiving notifications. Measuring it inverted the
 * concern. `endpoint` is not a rendered link — it is a **server-side outbound
 * request target supplied by the client**. `deliverWebPush` hands it to
 * `webpush.sendNotification` (`@/lib/notifications/web-push:81`), and
 * `web-push@3.6.7` performs **no scheme validation whatsoever**: measured, it
 * will happily attempt `http://169.254.169.254/latest/meta-data/`.
 *
 * So the field any authenticated tenant user can write is the one field here
 * that reaches an outbound fetch, and leaving it open was the riskier half.
 *
 * Two things make the pin safe to land rather than merely correct:
 *
 *   - Every major push service is https — FCM, Mozilla autopush, Apple Web
 *     Push, WNS.
 *   - Production has **zero** `PushSubscription` rows (measured 2026-08-21),
 *     so no stored endpoint can be orphaned by the tightened unsubscribe
 *     payload below.
 *
 * ## The host policy (#696)
 *
 * The scheme pin alone is not an SSRF guard — `https://169.254.169.254/`
 * passes it. `checkPushEndpoint` adds the host half: the same policy the
 * automation webhook path uses, plus a rejection of single-label hosts
 * (`https://redis/` resolves inside the compose network, and the host-less
 * `https:///path` form parses to one).
 *
 * ## Why the check here is STRUCTURAL only
 *
 * `withValidatedBody` calls `schema.parse(raw)` — synchronous
 * (`src/lib/validation/route.ts:23`) — so an async refinement is impossible at
 * this seam. The DNS half (`assertPublicAddress`) runs at SEND time in
 * `deliverWebPush`, which is also the only place a row stored under an older
 * policy is ever re-examined. Both halves are needed; neither is sufficient.
 */
export const PushSubscriptionSchema = z.object({
    endpoint: httpsUrl().refine(
        (u) => checkPushEndpoint(u).ok,
        'Endpoint host is not an allowed push service address',
    ),
    keys: z.object({
        p256dh: z.string().min(1).max(500),
        auth: z.string().min(1).max(500),
    }),
});

/**
 * Unsubscribe payload. Deliberately looser than the subscribe schema above: it
 * pins the scheme but NOT the host policy.
 *
 * A DELETE causes no outbound request and can only remove the caller's own
 * row. Applying the host rule here would make a row stored under an older
 * policy undeletable through the API — and the send path never prunes a
 * blocked endpoint (see `deliverWebPush`), so there would be no other way to
 * get rid of it.
 */
export const RemovePushSubscriptionSchema = z.object({
    endpoint: httpsUrl(),
});

/**
 * An APNs device token (#1764).
 *
 * ## Why this is a separate member rather than widened fields
 *
 * `PushSubscriptionSchema` above is UNCHANGED, deliberately. The web client
 * posts `{endpoint, keys}` with no `platform`, and that body must keep parsing
 * byte-for-byte — `tests/unit/small-schemas.test.ts` exercises it and is now
 * doing double duty as the back-compat control.
 *
 * ## Hex, pinned; length BOUNDED rather than fixed
 *
 * The token goes into an HTTP/2 request path to Apple, so an unvalidated value
 * is a request-splitting shape at the one field a client controls — the same
 * reasoning that pinned `endpoint` above, one transport over.
 *
 * What carries that property is the ALPHABET. Hex admits no `/`, no CR or LF
 * and no space, so there is nothing in a conforming value to interpret as
 * structure. The exact COUNT never carried it, and pinning it to 64 bet on a
 * size Apple does not promise.
 *
 * That bet was measured and lost: agrent-ios found an 80-byte token (160 hex)
 * on a simulator, and Apple documents device tokens as variable length. A
 * device issuing one would have received a 400 on every registration —
 * silent, because a phone that cannot register simply receives nothing.
 * Today's real tokens are 32 bytes and the owner's passed the old pin, so this
 * is a latent fault rather than a live one.
 *
 * 64 to 200 hex characters is 32 to 100 bytes: the known sizes with headroom,
 * and still a hard ceiling. Unbounded would hand a caller the length of a path
 * we construct, which is the half of the original reasoning worth keeping.
 *
 * Case-insensitive because Apple's own documentation and the iOS
 * `Data.description` path differ on it, and a token rejected for being
 * uppercase would be a silent registration failure on the client's side.
 */
export const ApnsRegistrationSchema = z.object({
    platform: z.literal('IOS'),
    deviceToken: z
        .string()
        .regex(
            /^[0-9a-f]{64,200}$/i,
            'Device token must be 64 to 200 hexadecimal characters',
        ),
    /**
     * Which APNs host this token is valid against — #1764 step 3.
     *
     * LOWER-CASE on the wire because that is what `aps-environment` in the
     * app's provisioning profile says, and the client reads it from there
     * rather than deciding for itself. The column is the enum
     * `ApnsEnvironment`; the mapping happens once, in the usecase.
     *
     * OPTIONAL, and that is a compatibility requirement rather than
     * leniency: agrent-ios ships the field in a build that follows this one,
     * so a required field would reject every registration from the build
     * that is installed today — and a phone that cannot register receives
     * nothing. An absent value stores NULL, which the sender refuses and
     * logs rather than guessing a host.
     */
    environment: z.enum(['development', 'production']).optional(),
});

/**
 * What `POST /api/t/{tenantSlug}/push-subscriptions` accepts.
 *
 * A plain `z.union`, NOT `z.discriminatedUnion`, and the reason is back
 * compatibility rather than taste: the discriminated form reads the
 * discriminator out of the INPUT, and the web client sends no `platform` at
 * all. The web member is first so an existing body matches it directly.
 */
export const PushRegistrationSchema = z.union([
    PushSubscriptionSchema,
    ApnsRegistrationSchema,
]);

/** The unsubscribe counterpart. Looser than registration, for the reason above. */
export const RemoveApnsRegistrationSchema = z.object({
    platform: z.literal('IOS'),
    // Same bound as registration. An unregister that refused a token the
    // register accepted would strand the row it was meant to remove — and
    // that is the direction where a phone cannot clean up after itself.
    deviceToken: z.string().regex(/^[0-9a-f]{64,200}$/i),
});

export const RemovePushRegistrationSchema = z.union([
    RemovePushSubscriptionSchema,
    RemoveApnsRegistrationSchema,
]);
