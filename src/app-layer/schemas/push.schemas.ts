import { z } from 'zod';
import { httpsUrl } from '@/lib/schemas/url';

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
 * ## What this does NOT fix
 *
 * `https://169.254.169.254/` still passes. A scheme pin is not an SSRF guard —
 * the host policy this repo already has for the analogous automation webhook
 * path (`checkWebhookUrl`) has no counterpart here. Tracked separately; do not
 * read this docblock as saying the SSRF is closed.
 */
export const PushSubscriptionSchema = z.object({
    endpoint: httpsUrl(),
    keys: z.object({
        p256dh: z.string().min(1).max(500),
        auth: z.string().min(1).max(500),
    }),
});

/**
 * Unsubscribe payload. Pinned to match the subscribe schema — a value that
 * could never be stored must not be accepted for removal either.
 */
export const RemovePushSubscriptionSchema = z.object({
    endpoint: httpsUrl(),
});
