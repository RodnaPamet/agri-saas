/**
 * SCIM provisioning is turned off (owner ruling 2026-11-18): dormant, not
 * removed. The token screen answers `notFound()` while the `auth.scim` flag is
 * off, matching `/api/t/{slug}/admin/scim` and `/api/scim/v2/**`, and the hub
 * omits its tile on the same flag.
 *
 * A layout rather than a check in the page because the page is a client
 * component, and flags are resolved on the server only.
 */
import { notFound } from 'next/navigation';

import { isScimEnabled } from '@/lib/auth/tenant-sso-availability';

export default async function ScimLayout({ children }: { children: React.ReactNode }) {
    if (!(await isScimEnabled())) notFound();
    return children;
}
