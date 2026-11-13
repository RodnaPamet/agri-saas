import { OfflineFieldPanel } from '@/components/offline/OfflineFieldPanel';
import { env } from '@/env';

/**
 * Operator field-execution page — the offline-capable, phones-with-gloves
 * surface for executing a spray job. Mark lines done/skip in the field;
 * the marks queue + sync via the outbox when signal returns.
 *
 * ## It also publishes the VAPID public key — P7.4 (#1993)
 *
 * Read from `env` HERE, in a server component, rather than through
 * `NEXT_PUBLIC_VAPID_PUBLIC_KEY` in the client. That variable is inlined by
 * `next build` and reached no Dockerfile `ARG`, so every image baked
 * `undefined` and the opt-in control rendered as unsupported in production for
 * its whole life — the same trap #1982 found for the SSE flag.
 *
 * Reading it at request time means configuring web push is an env change plus
 * a container restart, with no rebuild. The value is a PUBLIC key — it is
 * `applicationServerKey`, which the browser hands to the push service — so
 * sending it to the client is its purpose, not a leak.
 *
 * This page must stay DYNAMIC for that to hold: a statically rendered page
 * would read `env` once at build time and re-bake the old behaviour with none
 * of the old spelling to notice. It is dynamic today because it awaits
 * `params` and because `t/[tenantSlug]/layout.tsx` calls `noStore()`, and
 * `tests/guards/vapid-key-is-served-at-runtime.test.ts` is what keeps it so.
 *
 * ## Nothing in the product NAVIGATES here, and that is deliberate (#3048)
 *
 * An operator arrives from a QR code on the machine or from a push
 * notification, never from in-app navigation: the MECHANISATOR persona is
 * locked out of the rest of the product by `isOperatorAllowedPath`, so a link
 * from a screen they cannot open would be the wrong affordance.
 *
 * That is a statement about the PAGE, not about any guard.
 * `pages-are-reachable` finds this page reachable — a push payload and a QR
 * code are both ways in — so it carries no `DELIBERATELY_UNLINKED` entry; it
 * had one until #3048, and that entry suppressed nothing from the day it was
 * written. Keep the reasoning here, where it is checkable against the
 * persona lockdown rather than against a list in a test.
 */
export default async function OperatorFieldPage({ params }: { params: Promise<{ tenantSlug: string; taskId: string }> }) {
    const { taskId } = await params;
    return <OfflineFieldPanel taskId={taskId} vapidPublicKey={env.VAPID_PUBLIC_KEY ?? null} />;
}
