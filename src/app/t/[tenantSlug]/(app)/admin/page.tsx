import { getTranslations } from 'next-intl/server';
import { Shield, CreditCard, KeyRound, ShieldCheck, ShieldPlus, Users, UserCog, CloudCog, Plug, Palette, Bell, ScrollText, ToggleLeft, Tractor, Globe } from 'lucide-react';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button-variants';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { PageHeader } from '@/components/layout/PageHeader';
import { getTenantCtx } from '@/app-layer/context';
import { isPlatformTenant } from '@/lib/auth/platform-support';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { LanguageSetting } from './LanguageSetting';

export const dynamic = 'force-dynamic';

/**
 * Admin landing — pure pill-nav surface.
 *
 * R13-PR10 retired the embedded audit log tab and the policy
 * templates tab. Audit log now lives at its own page
 * (`/admin/audit-log`) reachable via the pill next to
 * Notifications. Policy templates were unused chrome and were
 * dropped entirely.
 *
 * ## This page is the ONLY way into most admin screens
 *
 * Which is a responsibility, not a description. `/admin/public-profile`
 * shipped in P6 — flag on, route resolving, robots and sitemap ready — and was
 * linked from NOWHERE: not here, not in `canonical-parents.ts`, not in the
 * sidebar. Measured 2026-11-07: zero `FarmBrand` rows in production, so not
 * one farm had ever started a brand, because the only path to the screen was
 * typing a URL nobody had seen (#2844).
 *
 * Every P6 check asked whether the surface was REACHABLE, and it was. None
 * asked whether a person could FIND it. `pages-are-reachable` now derives that
 * question from the filesystem, so a new screen under `(app)` is covered the
 * moment it exists.
 */
export default async function AdminPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;

    const t = await getTranslations('admin');

    // Resolved on the SERVER. There is no client-side flags hook in this
    // codebase and adding one would be a second source of truth for a kill
    // switch — the same reason `admin/public-profile/page.tsx` resolves it
    // here rather than passing the key down.
    //
    // Absent rather than disabled when the flag is off: a disabled control
    // advertises a feature that does not exist, which is the opposite of a
    // dark launch. The page itself answers `notFound()` on the same flag, so
    // the two halves agree.
    const ctx = await getTenantCtx({ tenantSlug });
    const publicProfile = await isFeatureEnabled('social.public-profile', ctx.userId);

    // The platform-support usage console. Same conditions the page itself
    // applies, so the tile and the screen agree — and gated SERVER-side, so
    // another tenant is told nothing: that page answers `notFound()` rather
    // than a denial precisely because a denial "would confirm there is a
    // surface worth going to look for", and a tile that rendered for everyone
    // would do exactly that.
    //
    // It was found by `pages-are-reachable`, not by design review: the
    // platform operator had no discoverable path to their own console either.
    const usageConsole = isPlatformTenant(tenantSlug) && ctx.permissions.canAdmin;

    const tenantHref = (path: string) => `/t/${tenantSlug}${path}`;

    return (
        <div className="space-y-section animate-fadeIn">
            <PageHeader
                breadcrumbs={[
                    { label: 'Dashboard', href: tenantHref('/dashboard') },
                    { label: t('title') },
                ]}
                title={t('title')}
                actions={
                    <div className="flex items-center gap-tight flex-wrap">
                        <LanguageSetting />
                        <div
                            className="flex items-center gap-compact rounded-lg border border-border-subtle bg-bg-default px-3 py-1.5"
                            id="admin-theme-section"
                        >
                            <Palette className="w-4 h-4 text-content-muted" />
                            <span className="text-sm text-content-muted">{t('hub.theme')}</span>
                            <ThemeToggle id="admin-theme-toggle" />
                        </div>
                    </div>
                }
            />

            {/* Navigation pills — pure server-rendered links. */}
            <div className="flex gap-tight flex-wrap">
                <Link
                    href={tenantHref('/admin/members')}
                    className={buttonVariants({ variant: 'secondary' })}
                    id="members-pill-btn"
                >
                    <Users className="w-3.5 h-3.5" />
                    {t('hub.membersAndRoles')}
                </Link>
                <Link
                    href={tenantHref('/admin/rbac')}
                    className={buttonVariants({ variant: 'secondary' })}
                    id="rbac-pill-btn"
                >
                    <Shield className="w-3.5 h-3.5" />
                    {t('hub.rolesAndAccess')}
                </Link>
                <Link
                    href={tenantHref('/admin/roles')}
                    className={buttonVariants({ variant: 'secondary' })}
                    id="custom-roles-pill-btn"
                >
                    <ShieldPlus className="w-3.5 h-3.5" />
                    {t('hub.customRoles')}
                </Link>
                <Link
                    href={tenantHref('/admin/api-keys')}
                    className={buttonVariants({ variant: 'secondary' })}
                    id="api-keys-pill-btn"
                >
                    <KeyRound className="w-3.5 h-3.5" />
                    {t('hub.apiKeys')}
                </Link>
                <Link
                    href={tenantHref('/admin/billing')}
                    className={buttonVariants({ variant: 'secondary' })}
                    id="billing-pill-btn"
                >
                    <CreditCard className="w-3.5 h-3.5" />
                    {t('hub.billing')}
                </Link>
                <Link
                    href={tenantHref('/admin/sso')}
                    className={buttonVariants({ variant: 'secondary' })}
                    id="sso-pill-btn"
                >
                    <KeyRound className="w-3.5 h-3.5" />
                    {t('hub.ssoIdentity')}
                </Link>
                <Link
                    href={tenantHref('/admin/scim')}
                    className={buttonVariants({ variant: 'secondary' })}
                    id="scim-pill-btn"
                >
                    <CloudCog className="w-3.5 h-3.5" />
                    {t('hub.scimProvisioning')}
                </Link>
                <Link
                    href={tenantHref('/admin/entra')}
                    className={buttonVariants({ variant: 'secondary' })}
                    id="entra-pill-btn"
                >
                    <UserCog className="w-3.5 h-3.5" />
                    {t('hub.entraAccessMapping')}
                </Link>
                <Link
                    href={tenantHref('/admin/integrations')}
                    className={buttonVariants({ variant: 'secondary' })}
                    id="integrations-pill-btn"
                >
                    <Plug className="w-3.5 h-3.5" />
                    {t('hub.integrations')}
                </Link>
                <Link
                    href={tenantHref('/admin/modules')}
                    className={buttonVariants({ variant: 'secondary' })}
                    id="modules-pill-btn"
                >
                    <ToggleLeft className="w-3.5 h-3.5" />
                    {t('hub.modules')}
                </Link>
                <Link
                    href={tenantHref('/admin/farm-profile')}
                    className={buttonVariants({ variant: 'secondary' })}
                    id="farm-profile-pill-btn"
                >
                    <Tractor className="w-3.5 h-3.5" />
                    {t('hub.farmProfile')}
                </Link>
                {publicProfile ? (
                    <Link
                        href={tenantHref('/admin/public-profile')}
                        className={buttonVariants({ variant: 'secondary' })}
                        id="public-profile-pill-btn"
                    >
                        <Globe className="w-3.5 h-3.5" />
                        {t('hub.publicProfile')}
                    </Link>
                ) : null}
                {usageConsole ? (
                    <Link
                        href={tenantHref('/admin/usage')}
                        className={buttonVariants({ variant: 'secondary' })}
                        id="usage-pill-btn"
                    >
                        <ScrollText className="w-3.5 h-3.5" />
                        {t('hub.usage')}
                    </Link>
                ) : null}
                <Link
                    href={tenantHref('/admin/security')}
                    className={buttonVariants({ variant: 'secondary' })}
                    id="security-pill-btn"
                >
                    <ShieldCheck className="w-3.5 h-3.5" />
                    {t('hub.securityMfa')}
                </Link>
                <Link
                    href={tenantHref('/admin/notifications')}
                    className={buttonVariants({ variant: 'secondary' })}
                    id="notifications-pill-btn"
                >
                    <Bell className="w-3.5 h-3.5" />
                    {t('hub.notifications')}
                </Link>
                <Link
                    href={tenantHref('/admin/ledger-integrity')}
                    className={buttonVariants({ variant: 'secondary' })}
                    id="ledger-integrity-pill-btn"
                >
                    <ShieldCheck className="w-3.5 h-3.5" />
                    {t('hub.ledgerIntegrity')}
                </Link>
                <Link
                    href={tenantHref('/admin/audit-log')}
                    className={buttonVariants({ variant: 'secondary' })}
                    id="audit-log-pill-btn"
                >
                    <ScrollText className="w-3.5 h-3.5" />
                    {t('auditLog')}
                </Link>
            </div>
        </div>
    );
}
