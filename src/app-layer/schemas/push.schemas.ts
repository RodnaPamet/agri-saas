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
