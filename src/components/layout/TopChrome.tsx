'use client';

/**
 * TopChrome — Roadmap-2 PR-2 (PR-11 simplification, R14-PR1
 * primitive extraction).
 *
 * Thin consumer of the `<NavBar>` primitive. Reads page-scoped
 * data via two contexts and fills the structural slots:
 *
 *   • Left slot   — breadcrumbs (from `useCurrentBreadcrumbs`).
 *     R14-PR3 adds the brand mark before breadcrumbs.
 *     R14-PR9 adds the env badge between brand + breadcrumbs.
 *
 *   • Centre slot — empty.
 *     R14-PR6 originally filled this with the `<SearchAnchor>`
 *     pill; the searchbar-kill sweep retired it. The ⌘K palette
 *     stays globally accessible via the keyboard shortcut that
 *     `<CommandPaletteProvider>` registers — no visual surface
 *     in the chrome.
 *
 *   • Right slot  — context identity pill (tenant or org name).
 *     R14-PR4 replaces this with the workspace switcher.
 *     R14-PR5 adds the user menu.
 *     R14-PR7 adds the notifications bell.
 *
 * The chrome is mounted once by `<AppShell>` and routes through
 * the variant-specific identity context. R14-PR4 evolved the
 * tenant variant from the passive R2 identity pill to a
 * `<TenantSwitcher>` popover; the org variant continues to mount
 * the passive `<OrgIdentityPill>` until a future PR extends. Each
 * affordance calls its own context hook (`useTenantContext` /
 * `useOrgContext`) unconditionally and never throws — AppShell's
 * `variant` prop picks the right one for the route.
 *
 * Mobile (<md): the chrome is hidden — the pre-existing mobile top
 * bar inside `<AppShell>` continues to handle nav-toggle + theme.
 * R14-PR12 unifies the two; until then the mobile bar is the
 * authoritative mobile surface.
 */
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Breadcrumbs } from '@/components/ui/breadcrumbs';
import { useCurrentBreadcrumbs } from './breadcrumbs-store';
// PR-2 — OrgIdentityPill retired in favour of OrgWorkspaceSwitcher
// (interactive popover); the passive pill stays exported from
// `./IdentityPill` for any other consumer that imports it directly
// but TopChrome no longer mounts it. Comment kept for grep-ability.
import { TenantSwitcher } from './tenant-switcher';
import { OrgWorkspaceSwitcher } from './org-workspace-switcher';
import { UserMenu } from './user-menu';
import { NotificationsBell } from './notifications-bell';
import { EnvironmentBadge } from './environment-badge';
import type { AppShellVariant } from './AppShell';
import { NavBar, NavBarBrand, NavBarMobileMenu } from './nav-bar';

interface TopChromeProps {
    variant: AppShellVariant;
    /**
     * Operator (MECHANISATOR) mode — a minimal bar: brand + user menu only.
     * No mobile-menu button (there's no drawer), no breadcrumbs, no workspace
     * switcher, no notifications bell. Keeps the operator on their one screen.
     */
    operator?: boolean;
    /**
     * R14-PR12 — handler for the mobile-only menu button. Opens
     * the sidebar drawer. AppShell owns the drawer-open state and
     * passes the setter through.
     */
    onMobileMenuClick: () => void;
    /**
     * R14-hotfix — user data threaded from the server-side layout
     * (`session.user`). Replaces the `useSession()` calls that
     * R14-PR4 + PR-5 introduced (which violated the project's
     * no-SessionProvider convention).
     */
    user: {
        name?: string | null;
        email?: string | null;
        /** Profile-photo URL (OAuth image or the avatar serve route)
         *  — threaded into the user-menu avatar. Avatar roadmap P4. */
        image?: string | null;
        memberships?: Array<{
            slug: string;
            role: string;
            tenantId: string;
        }>;
        /**
         * B4 — organization memberships threaded into the workspace
         * picker. When the user belongs to one or more orgs, the
         * switcher popover renders an "Organizations" section above
         * the workspaces list. Optional so callers in pre-B4 stacks
         * don't need to thread it.
         */
        orgMemberships?: Array<{
            slug: string;
            role: string;
            organizationId: string;
        }>;
    };
}

/**
 * Sticky top chrome. Hidden on mobile to preserve vertical space —
 * the existing mobile top bar in `<AppShell>` is a load-bearing
 * surface there.
 *
 * R14-PR3 adds the animated brand mark before breadcrumbs in the
 * left slot. The mark's destination href is computed from the
 * variant + URL params: tenant → `/t/<slug>/dashboard`,
 * org → `/org/<slug>` (org root).
 */
export function TopChrome({ variant, operator = false, user, onMobileMenuClick }: TopChromeProps) {
    const t = useTranslations('topChrome');
    const breadcrumbs = useCurrentBreadcrumbs();
    const params = useParams();
    // R14-PR4 — tenant variant mounts <TenantSwitcher> (popover).
    // PR-2 — org variant now mounts <OrgWorkspaceSwitcher> — same
    // popover-driven UX with the active context surfaced on the
    // trigger. Pre-PR-2 the org variant only had a passive
    // identity pill linking to `/tenants`, which made org → tenant
    // switching a two-click navigation while tenant → org was
    // one-click. Switcher parity restores symmetric context-
    // switching.
    const renderIdentity = () =>
        variant === 'org' ? (
            <OrgWorkspaceSwitcher
                memberships={user.memberships ?? []}
                orgMemberships={user.orgMemberships ?? []}
            />
        ) : (
            <TenantSwitcher
                memberships={user.memberships ?? []}
                orgMemberships={user.orgMemberships ?? []}
            />
        );

    // The brand mark's destination is the current variant's root.
    // Tenant pages: dashboard is the canonical landing surface.
    // Org pages: the org's root index (no `/dashboard` route).
    // Fallback to `/` if params haven't resolved yet — first paint
    // in App Router can run before `useParams()` populates.
    const brandHref =
        variant === 'org'
            ? params?.orgSlug
                ? `/org/${params.orgSlug}`
                : '/'
            : params?.tenantSlug
              ? // Operator mode: the brand mark is the "home" affordance back
                // to the one screen they own (the dashboard is off-limits and
                // would just bounce them here anyway).
                operator
                  ? `/t/${params.tenantSlug}/my-work`
                  : `/t/${params.tenantSlug}/dashboard`
              : '/';

    // Offline diagnostics (#648). Two independent reasons to omit it, and
    // BOTH have to be checked here rather than inside the menu:
    //
    //   • no tenant in scope — this chrome also mounts on org pages, where
    //     the route does not exist;
    //   • operator mode — `isOperatorAllowedPath` does not list
    //     `/diagnostics/*`, so a MECHANISATOR tapping it is redirected to
    //     `/my-work`. A row that silently bounces reads as a broken
    //     instrument, which is worse than an absent one. That the field
    //     operator is locked out of the instrument measuring their own
    //     phone is a real gap, tracked separately — not something to paper
    //     over with a link that does not work.
    const diagnosticsHref =
        variant === 'tenant' && !operator && params?.tenantSlug
            ? `/t/${params.tenantSlug}/diagnostics/offline`
            : null;

    return (
        <NavBar
            left={
                <>
                    {/* No mobile-menu button in operator mode — there's no
                        drawer to open. */}
                    {!operator && (
                        <NavBarMobileMenu
                            onClick={onMobileMenuClick}
                            ariaLabel={
                                variant === 'org'
                                    ? t('openOrgNav')
                                    : t('openNav')
                            }
                            dataTestId={
                                variant === 'org' ? 'org-nav-toggle' : 'nav-toggle'
                            }
                        />
                    )}
                    <NavBarBrand href={brandHref} />
                    <EnvironmentBadge />
                    {/* Breadcrumbs hidden below md — the brand mark
                        + env badge + hamburger already crowd the
                        left slot on small viewports. Mobile users
                        navigate via the drawer + the brand-mark
                        click. Operator mode has no breadcrumbs (one screen). */}
                    {!operator && (
                        <span className="hidden md:inline-flex items-center">
                            {breadcrumbs.length > 0 ? (
                                <Breadcrumbs
                                    items={breadcrumbs}
                                    data-testid="top-chrome-breadcrumbs"
                                />
                            ) : (
                                // No breadcrumbs pushed yet — empty sentinel
                                // for layout stability so the chrome's
                                // height doesn't jump when a page resolves
                                // its breadcrumbs after first paint.
                                <span className="sr-only">{t('noBreadcrumbs')}</span>
                            )}
                        </span>
                    )}
                </>
            }
            right={
                <>
                    {/* Operator mode: no workspace switcher, no notifications
                        bell — just the account menu (sign out / language). */}
                    {!operator && renderIdentity()}
                    {!operator && <NotificationsBell />}
                    <UserMenu
                        displayName={user.name ?? null}
                        displayEmail={user.email ?? null}
                        displayImage={user.image ?? null}
                        diagnosticsHref={diagnosticsHref}
                    />
                </>
            }
        />
    );
}
