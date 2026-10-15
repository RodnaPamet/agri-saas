/**
 * P6.6 — the owner's editor for the farm's public page (#1884).
 *
 * The four `farm-brand` endpoints and the public page at `/f/{handle}` all
 * shipped before this existed, so the whole feature was API-only: a farmer
 * could not choose an address, write a description, consent, or publish
 * without an HTTP client. Measured before this page: zero UI callers on any
 * of the four endpoints.
 *
 * ## A server page that resolves the flag, then a client form
 *
 * `isFeatureEnabled` is resolved HERE because there is no client-side flags
 * hook — the same shape the exchange thread page uses. The API routes gate
 * again independently (#1886), so a client that kept a stale page still gets
 * a 404 from every write.
 *
 * `notFound()` rather than a "coming soon" panel: a dark-launched surface
 * should not be discoverable, which is the same reasoning
 * `assertFeatureEnabled` applies on the routes.
 *
 * Its SIBLING is `admin/farm-profile`, the PRIVATE identity holding ЕГН, ЕИК
 * and the address. Two pages, deliberately adjacent and deliberately
 * separate: one is what the state requires of a farm, the other is what the
 * farm chooses to say about itself, and the only thing they must never do is
 * share a field.
 */
import { notFound } from 'next/navigation';

import { getTenantCtx } from '@/app-layer/context';
import { isFeatureEnabled } from '@/lib/feature-flags';

import { PublicProfileClient } from './PublicProfileClient';

export default async function AdminPublicProfilePage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    if (!(await isFeatureEnabled('social.public-profile', ctx.userId))) notFound();

    return <PublicProfileClient />;
}
