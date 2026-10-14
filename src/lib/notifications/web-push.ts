/**
 * Web Push delivery — the browser-push channel for the notification system.
 * Server-only by construction (imports the `web-push` Node lib + the
 * tenant-scoped DB context helper);
 * never import it from a client component.
 *
 * Opt-in + permission-graceful at every layer:
 *   - Unconfigured (no VAPID keys) → {@link isWebPushConfigured} is false and
 *     every send is a silent no-op, so dev/CI/self-hosted run without push.
 *   - Per recipient: a user with no subscriptions is skipped.
 *   - Dead endpoints (404/410 from the push service) are pruned so they
 *     don't accumulate. A BLOCKED endpoint is never pruned — see the gate
 *     below: `PushOptIn.tsx:46-49` renders a static "alerts on" span with no
 *     button once the browser holds a subscription, and `public/sw.js` has no
 *     `pushsubscriptionchange` handler, so deleting the row would be permanent
 *     silent notification loss with no way for the operator to recover.
 *
 * Never holds a DB transaction open across the network send: the
 * subscriptions are read in a short tenant-scoped tx, the actual sends fan
 * out OUTSIDE any tx, and pruning is a second short tx. Always awaited by
 * the caller so the push fires within the originating request/job.
 */
import webpush from 'web-push';
import { runInTenantContext } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';
import { checkPushEndpoint, assertPublicAddress } from '@/app-layer/automation/webhook-safety';
import { env } from '@/env';
import type { RequestContext } from '@/app-layer/types';

let configured: boolean | null = null;

/** True once VAPID keys are present + applied. Cached after first check. */
export function isWebPushConfigured(): boolean {
    if (configured !== null) return configured;
    const pub = env.VAPID_PUBLIC_KEY;
    const priv = env.VAPID_PRIVATE_KEY;
    if (pub && priv) {
        webpush.setVapidDetails(env.VAPID_SUBJECT || 'mailto:ops@agrent.bg', pub, priv);
        configured = true;
    } else {
        configured = false;
    }
    return configured;
}

export interface WebPushPayload {
    title: string;
    body: string;
    /** Deep-link opened on notification click. */
    url?: string;
    /** Coalescing tag — a newer push with the same tag replaces the old. */
    tag?: string;
}

/**
 * Send a Web Push to every device the recipient has subscribed in this
 * tenant. `ctx` provides the tenant scope for the (RLS-bound) subscription
 * read/prune; `recipientUserId` is who receives it. Fully best-effort.
 */
export async function sendWebPushToUser(
    ctx: RequestContext,
    recipientUserId: string,
    payload: WebPushPayload,
): Promise<void> {
    if (!isWebPushConfigured()) return;

    let subs: Array<{ id: string; endpoint: string; p256dh: string; auth: string }> = [];
    try {
        /**
         * `platform: 'WEB'` is load-bearing, not tidiness (#1764).
         *
         * The table now holds APNs rows too, and they have no `endpoint` — so
         * without this filter they would be fetched, fail the SSRF gate below
         * on a null endpoint, and be counted as dead devices by the prune at
         * the end. Filtering in SQL rather than after the read means an iOS
         * row never enters this function's world at all.
         *
         * The per-row dispatch that picks a transport belongs one level up;
         * this function's whole contract is Web Push, and it says so.
         */
        const rows = await runInTenantContext(ctx, (db) =>
            db.pushSubscription.findMany({
                where: { tenantId: ctx.tenantId, userId: recipientUserId, platform: 'WEB' },
                select: { id: true, endpoint: true, p256dh: true, auth: true },
                take: 25,
            }),
        );
        /**
         * The three columns are nullable in the schema and non-null for a WEB
         * row by `PushSubscription_web_shape`. This filter is what makes
         * TypeScript agree — and it is a DEFENCE rather than a cast: a row
         * that somehow carried a null here (a constraint dropped by a future
         * migration, a direct database write) is skipped instead of crashing
         * a notification send for every other device the person owns.
         */
        subs = rows.flatMap((r) =>
            r.endpoint !== null && r.p256dh !== null && r.auth !== null
                ? [{ id: r.id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }]
                : [],
        );
    } catch {
        return; // reading subs failed — nothing to send
    }
    if (subs.length === 0) return;

    // ── SSRF gate, at the only seam that sees a STORED endpoint (#696) ──
    //
    // `endpoint` is client-supplied and `web-push@3.6.7` validates nothing —
    // read its source: the only check is "non-empty string", the SCHEME is
    // discarded (`url.parse` → hostname/port/path → always `https.request`),
    // and the PORT is attacker-chosen. Measured, it will attempt
    // `http://169.254.169.254/latest/meta-data/`.
    //
    // The schema rejects a bad host at write time, but that cannot help a row
    // stored under an older policy, and a DNS answer can change after the row
    // was written. So both halves run here: the structural check, then the
    // resolve-and-recheck.
    const gated = await Promise.all(
        subs.map(async (s) => {
            const structural = checkPushEndpoint(s.endpoint);
            if (!structural.ok) return { sub: s, block: structural };
            const resolved = await assertPublicAddress(structural.host!);
            return { sub: s, block: resolved.ok ? null : resolved };
        }),
    );
    for (const g of gated) {
        if (!g.block) continue;
        // A DISTINCT event, never `web-push.send_failed`. That line's only
        // discriminator is `status`, and a block would arrive as `status: 0` —
        // indistinguishable from a network blip. Host and reason only; the
        // endpoint path is a capability URL.
        logger.warn('web-push.endpoint_blocked', {
            component: 'web-push',
            tenantId: ctx.tenantId,
            host: g.block.host ?? 'unknown',
            reason: g.block.reason ?? 'blocked',
        });
    }
    const sendable = gated.filter((g) => !g.block).map((g) => g.sub);
    if (sendable.length === 0) return;

    const body = JSON.stringify(payload);
    const dead: string[] = [];
    await Promise.all(
        sendable.map(async (s) => {
            try {
                await webpush.sendNotification(
                    { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
                    body,
                    // web-push only sets a socket timeout when one is passed
                    // (`web-push-lib.js:222`); without this a send to a
                    // blackholed address hangs the calling request forever.
                    { timeout: 10_000 },
                );
            } catch (err) {
                const status = (err as { statusCode?: number }).statusCode;
                if (status === 404 || status === 410) {
                    dead.push(s.id); // subscription expired/unsubscribed — prune
                } else {
                    logger.warn('web-push.send_failed', {
                        component: 'web-push',
                        tenantId: ctx.tenantId,
                        status: status ?? 0,
                    });
                }
            }
        }),
    );

    if (dead.length > 0) {
        try {
            await runInTenantContext(ctx, (db) =>
                db.pushSubscription.deleteMany({ where: { id: { in: dead } } }),
            );
        } catch {
            /* prune is best-effort */
        }
    }
}
