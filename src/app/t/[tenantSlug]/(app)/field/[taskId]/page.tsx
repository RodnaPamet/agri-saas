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
 */
export default async function OperatorFieldPage({ params }: { params: Promise<{ tenantSlug: string; taskId: string }> }) {
    const { taskId } = await params;
    return <OfflineFieldPanel taskId={taskId} vapidPublicKey={env.VAPID_PUBLIC_KEY ?? null} />;
}
