/**
 * Tenant SAML / OIDC single sign-on and SCIM provisioning are TURNED OFF,
 * not removed (owner ruling 2026-11-18).
 *
 * The product signs people in with Google, Apple, Microsoft Entra ID and a
 * password. The per-farm SAML / OIDC connectors (`/admin/sso`) and SCIM 2.0
 * provisioning (`/admin/scim`, `/api/scim/v2/**`) stay in the codebase and in
 * the database — every `TenantIdentityProvider`, `UserIdentityLink`,
 * `ScimGroup` and SCIM token row is left exactly as it was — but nothing can
 * reach them while their flag is off.
 *
 * ## Why runtime flags rather than deletion
 *
 * The owner chose dormancy, and chose flags so that either surface can be
 * turned back on from the flag console without a deploy. Both are ordinary
 * `FeatureFlag` rows, which means the two rules in `@/lib/feature-flags`
 * apply unchanged: a key ABSENT from the table is OFF, and
 * `FEATURE_FLAGS_FORCE_OFF=1` turns them off too. Nothing has to be written
 * to production for this to take effect — no row exists, so both are off.
 *
 * ## What is deliberately NOT behind these flags
 *
 * Microsoft Entra ID. It is a `TenantIdentityProvider` of type `ENTRA_ID`,
 * configured under `/api/t/{slug}/sso/entra`, and its sign-in, group mappings
 * and role sync keep working. Note that SCIM was Entra's PUSH channel (group
 * lifecycle, deprovisioning); with SCIM off, Entra roles are still synced at
 * every Entra sign-in by `entra-group-sync`, but a person removed in Entra is
 * no longer removed here until somebody does it by hand.
 *
 * ## Requests carry no user
 *
 * The flags are resolved with `userId: null`. SSO start and callback run
 * before anybody is signed in and SCIM authenticates with a bearer token, so
 * a cohort-gated row would answer OFF for every request — turning either
 * surface back on means `enabled = true` with NO cohorts.
 */
import { assertFeatureEnabled, isFeatureEnabled } from '@/lib/feature-flags';

/** Flag key for tenant SAML / OIDC single sign-on. */
export const TENANT_SSO_FLAG = 'auth.tenant-sso';

/** Flag key for SCIM 2.0 provisioning. */
export const SCIM_FLAG = 'auth.scim';

export async function isTenantSsoEnabled(): Promise<boolean> {
    return isFeatureEnabled('auth.tenant-sso', null);
}

export async function isScimEnabled(): Promise<boolean> {
    return isFeatureEnabled('auth.scim', null);
}

/**
 * Refuse with a 404 while tenant SSO is off. This IS `assertFeatureEnabled`,
 * rather than a second throw beside it, so the refusal is the same one every
 * dark-launched surface gives — a dormant surface should not advertise that it
 * exists — and so there is one 404 for a flag, not two to keep in step.
 */
export async function assertTenantSsoEnabled(): Promise<void> {
    await assertFeatureEnabled('auth.tenant-sso', null);
}

export async function assertScimEnabled(): Promise<void> {
    await assertFeatureEnabled('auth.scim', null);
}
