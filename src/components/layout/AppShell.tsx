'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { SidebarContent, MobileDrawer } from '@/components/layout/SidebarNav';
import { OrgSidebarContent } from '@/components/layout/OrgSidebarNav';
import { SidebarCollapseProvider } from '@/components/layout/sidebar-collapse-context';
import { useLocalStorage } from '@/components/ui/hooks';
import { cn } from '@/lib/cn';
import { BreadcrumbsProvider } from './breadcrumbs-store';
import { TopChrome } from './TopChrome';
import { BottomTabBar } from './BottomTabBar';

// ─── Types ───

/**
 * User shape threaded through the shell from the server-side
 * layout (which resolves the session via `auth()`).
 *
 * The codebase deliberately does NOT mount a `<SessionProvider>`
 * client-side (see the rationale in `src/app/providers.tsx`); any
 * chrome that needs user data takes it via props. R14-PR4 +
 * R14-PR5 originally violated this by calling `useSession()` —
 * the hotfix on this branch threads the data here instead.
 */
interface AppShellUser {
    name?: string | null;
    email?: string | null;
    /**
     * Profile-photo URL. Either the OAuth `User.image` written at
     * sign-in (e.g. a Google CDN URL) or the in-app serve URL written
     * by the avatar upload flow (`/api/account/avatar/<id>`). Threaded
     * through to the user-menu avatar in the top chrome — avatar
     * roadmap P4.
     */
    image?: string | null;
    /**
     * Active tenant memberships from the JWT. Same shape as
     * `MembershipEntry` in `src/auth.ts` — `{ slug, role,
     * tenantId }`. Optional because the org variant has no
     * tenant context.
     */
    memberships?: Array<{
        slug: string;
        role: string;
        tenantId: string;
    }>;
    /**
     * B4 — active organization memberships from the JWT
     * (`OrgMembershipEntry`). Threaded into the workspace switcher
     * so the picker can show both org + tenant contexts in one
     * popover.
     */
    orgMemberships?: Array<{
        slug: string;
        role: string;
        organizationId: string;
    }>;
}

export type AppShellVariant = 'tenant' | 'org';

interface AppShellProps {
    /** Serializable user data resolved server-side */
    user: AppShellUser;
    /**
     * Pre-resolved app name (from server-side i18n).
     *
     * R14-PR12 retired the mobile-only top bar that rendered the
     * wordmark; the prop is preserved for caller compatibility
     * (the tenant + org layouts pass it from `tc('appName')`).
     * The value is no longer rendered anywhere — kept as a
     * deprecation slot until the callers can be updated in a
     * follow-up cleanup PR.
     */
    appName: string;
    /**
     * Roadmap-2 PR-1 — picks which sidebar nav this shell mounts.
     * 'tenant' = SidebarContent (Dashboard, Risks, Practices, …).
     * 'org'    = OrgSidebarContent (Portfolio, Tenants, Members, …).
     * Default: 'tenant' to preserve historical behaviour for callers
     * that omit the prop.
     */
    variant?: AppShellVariant;
    /**
     * Operator (MECHANISATOR) mode — renders NO navigation chrome (no
     * sidebar, no mobile drawer, no bottom-tab bar) and a minimal top bar
     * (brand + user menu only). The operator is confined to their "My work"
     * screen by the middleware route-guard; stripping the nav is the
     * display-side half of the lockdown.
     */
    operator?: boolean;
    children: React.ReactNode;
}

/**
 * Client-side app shell — Roadmap-2 PR-1 unified.
 *
 * Mounts the chrome that wraps every authenticated app surface
 * (tenant `/t/:slug/(app)/**` AND org `/org/:slug/**`):
 *   • Mobile drawer toggle state.
 *   • Sign-out handler (requires next-auth/react).
 *   • Route-change auto-close for the mobile drawer.
 *
 * Variant only changes WHICH sidebar nav we mount — the chrome
 * (mobile top bar, scrolling rules, viewport-clamp behaviour,
 * keyboard-shortcut wiring through MobileDrawer) is identical so
 * the two contexts feel the same to the user.
 *
 * Receives only serializable props from the server layout.
 *
 * Note: `data-testid="nav-toggle"` and `data-testid="org-nav-toggle"`
 * differ deliberately — Playwright tests bind to the variant-specific
 * selector to assert the right shell mounted.
 */
export function AppShell({
    user,
    // appName preserved on the interface for caller compat (R14-PR12);
    // no longer rendered anywhere — see the AppShellProps doc comment.
    appName: _appName,
    variant = 'tenant',
    operator = false,
    children,
}: AppShellProps) {
    const [drawerOpen, setDrawerOpen] = useState(false);
    // Desktop sidebar collapse (icon rail). Persisted so the choice survives
    // navigation + reloads. The mobile drawer is never collapsed.
    const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorage(
        'inflect:sidebar-collapsed',
        false,
    );
    const toggleSidebarCollapsed = useCallback(
        () => setSidebarCollapsed((c) => !c),
        [setSidebarCollapsed],
    );

    const handleLogout = useCallback(async () => {
        await signOut({ callbackUrl: '/login' });
    }, []);

    const closeDrawer = useCallback(() => setDrawerOpen(false), []);

    // Auto-close drawer on route change
    const pathname = usePathname();
    const prevPathname = useRef(pathname);
    useEffect(() => {
        if (prevPathname.current !== pathname) {
            setDrawerOpen(false);
            prevPathname.current = pathname;
        }
    }, [pathname]);

    // Variant-driven slot resolution.
    // R14-PR12 unified the chrome — the mobile-only top bar that
    // AppShell used to render with its own hamburger + theme
    // toggle is GONE. The single NavBar (mounted by TopChrome)
    // now renders on all viewports; AppShell still owns the
    // drawer state and passes the open-handler through.
    const Sidebar = variant === 'org' ? OrgSidebarContent : SidebarContent;

    const openDrawer = useCallback(() => setDrawerOpen(true), []);

    // Layout chain (Phase 1 of list-page-shell):
    //   • Mobile (<md): natural document scroll. `min-h-screen` on
    //     the wrapper, `overflow-auto` on <main>, no flex-column.
    //     The mobile sticky top bar continues to behave as before.
    //   • Desktop (md+): viewport-clamped flex chain. Wrapper is
    //     `h-screen overflow-hidden`, <main> is a flex column with
    //     `overflow-hidden`. The inner content div is the default
    //     scroll container for pages that DON'T use ListPageShell —
    //     pages that DO use the shell take over the flex chain and
    //     the inner div's overflow-y-auto becomes a no-op (because
    //     the shell is `flex-1 min-h-0` and never overflows the
    //     inner div).
    //
    // Every flex parent in this chain carries `min-h-0` so children
    // can shrink below their content size — without this, `flex-1`
    // grows to content and the chain breaks.
    return (
        // h-full at md+ relies on the html/body lock in globals.css
        // (height: 100%; overflow: hidden at md+). The wrapper fills
        // exactly the viewport because its parent (body) is locked.
        // min-h-screen is the mobile fallback — below md the body
        // scrolls naturally and min-h-screen ensures the shell fills
        // the visible viewport at minimum.
        // `safe-area-x` (mobile-native-feel PR-4b) pads the shell by
        // env(safe-area-inset-left/right) so a phone rotated landscape keeps
        // content clear of a side notch. It is PADDING (border-box), so it
        // can never widen the layout past the viewport — no horizontal drift
        // — and it resolves to 0 on non-notched / desktop devices. The fixed
        // BottomTabBar (inset-x-0 + safe-area-bottom) and Fab (right-4 +
        // safe-area-bottom) are viewport-fixed and unaffected — their bottom
        // insets still compose exactly as before.
        <div className="min-h-screen md:h-full md:overflow-hidden flex safe-area-x">
            {/* Desktop sidebar — hidden on mobile, visible on md+. Collapses to
                a 56px icon rail (w-14); expanded is a thinner 208px (w-52).
                Operator mode renders NO sidebar. */}
            {!operator && (
                <aside
                    className={cn(
                        'hidden md:flex bg-bg-default border-r border-border-subtle flex-col flex-shrink-0 transition-[width] duration-200 ease-out',
                        sidebarCollapsed ? 'md:w-14' : 'md:w-[180px]',
                    )}
                    data-collapsed={sidebarCollapsed ? 'true' : 'false'}
                >
                    <SidebarCollapseProvider collapsed={sidebarCollapsed}>
                        <Sidebar
                            user={user}
                            onLogout={handleLogout}
                            onToggleCollapse={toggleSidebarCollapsed}
                        />
                    </SidebarCollapseProvider>
                </aside>
            )}

            {/* Mobile drawer — only renders overlay on <md. Always expanded.
                Operator mode has no drawer (no nav to open). */}
            {!operator && (
                <MobileDrawer open={drawerOpen} onClose={closeDrawer}>
                    <SidebarCollapseProvider collapsed={false}>
                        <Sidebar user={user} onLogout={handleLogout} onNavClick={closeDrawer} />
                    </SidebarCollapseProvider>
                </MobileDrawer>
            )}

            {/* Main content */}
            <main className="flex-1 overflow-auto md:overflow-hidden md:flex md:flex-col min-w-0 md:min-h-0">
                {/* Unified top chrome (R14-PR12) — single NavBar
                    across mobile + desktop. The pre-R14 mobile-only
                    top bar that lived inline here was deleted; the
                    NavBar's hamburger slot (via NavBarMobileMenu)
                    replaces it. Theme toggle moved to the user
                    menu (R14-PR5). BreadcrumbsProvider wraps the
                    chrome AND the page tree so pages can push
                    breadcrumbs from any depth. */}
                <BreadcrumbsProvider>
                    <TopChrome
                        variant={variant}
                        operator={operator}
                        user={user}
                        onMobileMenuClick={openDrawer}
                    />

                {/* Inner content container.
                    Mobile: just padding + max-width + centering.
                    Desktop: ALSO a flex column itself so any
                    <ListPageShell> child can claim flex-1 to fill
                    height. Without `md:flex md:flex-col` here, the
                    shell falls back to natural height and the inner
                    div's overflow-y-auto ends up scrolling instead
                    of the table card scrolling internally — which is
                    the exact regression we're fixing. */}
                {/* B7 — large-monitor responsiveness. Pre-B7 the
                    content container was capped at `max-w-7xl`
                    (1280px); on 1440p and 4K screens the page sat
                    in a narrow column with vast empty margins. The
                    cap now climbs at 2xl to 1536px and unblocks
                    entirely beyond. `mx-auto` keeps the column
                    centred at every step. Readable content (detail
                    pages, modals) is clamped separately by their
                    own shell so prose still tops out at a sane
                    measure. */}
                <div className="p-4 md:p-6 max-w-7xl 2xl:max-w-screen-2xl 3xl:max-w-none mx-auto md:flex md:flex-col md:flex-1 md:min-h-0 md:overflow-y-auto md:w-full">
                    {children}
                    {/* Spacer so page content can scroll clear of the fixed
                        mobile bottom-tab bar (≈56px) + the device safe area.
                        Tenant variant + <md only; a no-op everywhere else. */}
                    {variant === 'tenant' && !operator && (
                        <div
                            aria-hidden="true"
                            data-testid="bottom-tab-spacer"
                            className="md:hidden h-[calc(3.5rem+env(safe-area-inset-bottom))]"
                        />
                    )}
                </div>
                </BreadcrumbsProvider>
            </main>

            {/* One-thumb mobile navigation — a fixed bottom-tab bar for the
                five most-used field surfaces (md:hidden). The hamburger
                MobileDrawer above keeps the long tail. Tenant variant only:
                the bar resolves its tabs from the tenant nav. */}
            {variant === 'tenant' && !operator && <BottomTabBar />}
        </div>
    );
}
