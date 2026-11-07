import { redirect } from 'next/navigation';

import { getTenantCtx } from '@/app-layer/context';
import { isModuleAvailable } from '@/app-layer/usecases/modules';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { ThreadsClient } from './ThreadsClient';

/**
 * The messaging screen — Борса threads AND direct messages (P8.4, #2798).
 *
 * ## Why direct messages are HERE rather than at `/messages`
 *
 * Owner ruling 2026-11-07: «Съобщения» stays with the exchange and there is no
 * second destination carrying that name, so this screen is the one inbox. The
 * ruling was needed because #2798's premise — that P8.5's merge dissolves the
 * name collision — is false: `listInbox` is person-scoped and deliberately
 * does not reproduce `exchange_thread_audience`, so both surfaces were always
 * going to persist.
 *
 * ## The gate is now a DISJUNCTION, and that is the point of this file
 *
 * It used to be `requireModule(ctx, 'EXCHANGE')` — redirect unless the
 * marketplace module is available. That is right for exchange threads, and its
 * old docblock said why: "a thread only exists because two farms are
 * negotiating on the marketplace, so a tenant without the module has nothing
 * here". It is WRONG for a direct message, which depends on no module at all.
 * Left as it was, a farm that switched the marketplace off would lose its
 * direct messages — and because the gate REDIRECTS, the symptom is "my
 * messages vanished", not an error anybody could act on.
 *
 * Measured on production 2026-11-07 before changing it: 3 live tenants, 0 with
 * customised `TenantModuleSettings`, so 0 with EXCHANGE off. The trap costs
 * nobody today, which is exactly why it would have shipped.
 *
 * So each half is gated on its OWN condition and the screen renders what the
 * caller may see:
 *
 *   - exchange threads  ← `isModuleAvailable(EXCHANGE)` (plan ∧ tenant)
 *   - direct messages   ← the `social.direct-messages` runtime flag
 *
 * Neither available ⇒ the original redirect, so a tenant with no marketplace
 * and no DMs behaves exactly as before rather than landing on an empty screen.
 *
 * **Relaxing the module gate wholesale would have been the other mistake**: it
 * would open exchange threads to a tenant whose plan does not include the
 * marketplace. The API routes gate independently on both axes — this is the
 * screen half, and it must not be the more permissive one.
 *
 * ## A DM list is the same under every farm, and that is inherent
 *
 * This route is `/t/{tenantSlug}/…` while a DM has no tenant, so a member of
 * three farms sees the SAME direct conversations under all three. Raised
 * before the ruling and chosen anyway. Do not try to "scope" it: the DM
 * policies key on `app.user_id`, which `runInTenantContext` does not set, so
 * reaching for a tenant context here returns zero rows with no error (#1664).
 */
export default async function ExchangeThreadsPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    const [exchangeAvailable, directMessages] = await Promise.all([
        isModuleAvailable(ctx, 'EXCHANGE'),
        isFeatureEnabled('social.direct-messages', ctx.userId),
    ]);

    if (!exchangeAvailable && !directMessages) {
        redirect(`/t/${ctx.tenantSlug}/dashboard`);
    }

    return <ThreadsClient exchange={exchangeAvailable} directMessages={directMessages} />;
}
