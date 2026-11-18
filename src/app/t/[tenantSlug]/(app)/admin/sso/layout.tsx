/**
 * Tenant SAML / OIDC single sign-on is turned off (owner ruling 2026-11-18):
 * dormant, not removed. The configuration screen answers `notFound()` while
 * the `auth.tenant-sso` flag is off, matching its API (`/api/t/{slug}/sso`)
 * and the hub, which omits its tile on the same flag.
 *
 * A layout rather than a check in the page because the page is a client
 * component, and there is no client-side flags hook — flags are resolved on
 * the server only (see `@/lib/feature-flags`).
 */
import { notFound } from 'next/navigation';

import { isTenantSsoEnabled } from '@/lib/auth/tenant-sso-availability';

export default async function TenantSsoLayout({ children }: { children: React.ReactNode }) {
    if (!(await isTenantSsoEnabled())) notFound();
    return children;
}
