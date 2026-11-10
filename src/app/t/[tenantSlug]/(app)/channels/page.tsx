import { notFound } from 'next/navigation';

import { getTenantCtx } from '@/app-layer/context';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { ChannelsDirectoryClient } from './ChannelsDirectoryClient';

/**
 * «Канали» — the channel directory (P9.5, #2939).
 *
 * ## Where this lives, and what it is called
 *
 * Owner rulings 2026-11-10: the noun is **«Канали»**, and it is a sidebar item
 * in the **«Пазар»** section beside «Борса», «Тенденции», «Новини» and
 * «Схеми» — not a bottom tab, because the cap is five and those path strings
 * are shared vocabulary with iOS, so a new tab would displace something AND
 * need a coordinated change with agrent-ios (#2942).
 *
 * «Канали» was chosen over «Общности», which I had recommended on the grounds
 * that «канал» is an irrigation ditch to a Bulgarian farmer. The measurement
 * went the other way: five refusals already shipped in P9.3 use the word
 * (`CHANNEL_ARCHIVED` → «Този канал е затворен», and four siblings), and the
 * irrigation sense appears nowhere in either catalogue. Renaming the surface
 * would have left those five using a noun the nav did not.
 *
 * ## The gate is the FLAG and nothing else
 *
 * No module. P8.4's lesson is that a surface depending on no module must not
 * inherit one's gate: a farm that switched the marketplace off would otherwise
 * lose a surface unrelated to the marketplace, and because a module gate
 * REDIRECTS the symptom would be "my channels vanished" rather than an error.
 * A channel is tenantless and depends on no plan tier.
 *
 * `notFound()` rather than a redirect, matching the DM conversation page next
 * door and the API: `assertFeatureEnabled` answers 404 on the same flag, so a
 * dark surface is one that does not resolve. Sending somebody to a dashboard
 * instead would read as "your channels were deleted".
 *
 * ## The tenant context is resolved only to AUTHENTICATE
 *
 * Channels are tenantless (P9.1's five models carry no `tenantId`) and their
 * policies key on `app.user_id`, which `runInTenantContext` does not set — so
 * nothing here may pass `ctx.tenantId` to a channel read, and a tenant-scoped
 * read would return zero rows with no error (#1664). The client fetches from
 * `/api/social/…`, which runs `runInUserContext`.
 *
 * A consequence worth stating, as P8.4 states it for DMs: this route is
 * `/t/{tenantSlug}/…` and a channel has no tenant, so a member of three farms
 * sees the SAME channels under all three. That is inherent, not a bug to scope
 * away.
 */
export default async function ChannelsPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    if (!(await isFeatureEnabled('social.channels', ctx.userId))) notFound();

    return <ChannelsDirectoryClient tenantSlug={tenantSlug} />;
}
