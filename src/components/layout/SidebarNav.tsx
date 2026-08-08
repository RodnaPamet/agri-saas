'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTenantContext, useTenantHref, usePermissions } from '@/lib/tenant-context-provider';
import { Tooltip } from '@/components/ui/tooltip';
import { useKeyboardShortcut } from '@/lib/hooks/use-keyboard-shortcut';
import { StartTourButton } from '@/components/ui/OnboardingTour';
import { useCommandPalette } from '@/components/command-palette/command-palette-provider';
import {
    X,
    LayoutDashboard,
    Building2,
    AlertTriangle,
    Paperclip,
    FileText,
    ClipboardList,
    Settings,
    LogOut,
    Calendar as CalendarIcon,
    PanelLeftClose,
    PanelLeftOpen,
    MapPin,
    Boxes,
    NotebookPen,
    Wheat,
    Warehouse,
    LineChart,
    Coins,
    ArrowLeftRight,
    CloudSun,
    CalendarClock,
    TrendingUp,
    Newspaper,
    ScrollText,
    type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useLocalStorage } from '@/components/ui/hooks';
import { useCalendarBadge } from './use-calendar-badge';
import { NavItem } from './nav-item';
import { NavSection } from './nav-section';
import { AgrentMark } from './AgrentLogo';
import { useSidebarCollapsed } from './sidebar-collapse-context';

// ─── Types ───

interface NavItemDef {
    href: string;
    label: string;
    icon: LucideIcon;
    badge?: string | number;
    /** If set, item is only shown when this returns true */
    visible?: boolean;
}

interface NavSectionDef {
    /**
     * Stable, locale-INDEPENDENT section id. Keys the foldable-section
     * open/closed state in localStorage (the translated `title` can't —
     * it changes with the UI language). The untitled Board home-link
     * group has no id and is never foldable.
     */
    id?: string;
    title?: string;
    items: NavItemDef[];
}

/**
 * Defense-in-depth nav filter (Layer 2 of 2):
 *   Layer 1 — the server layout uses noStore() so permissions AND module
 *             availability are resolved fresh per request.
 *   Layer 2 — this client-side filter removes gated items.
 * Fail-closed: when `visible` is explicitly set, only keep the item when it
 * is strictly `true`. An unset `visible` means "no gate — always shown".
 */
function filterVisible(items: NavItemDef[]): NavItemDef[] {
    return items.filter((item) => {
        if (item.visible === undefined) return true;
        return item.visible === true;
    });
}

// ─── Navigation configuration ───

export function useNavSections(): NavSectionDef[] {
    const t = useTranslations('sidebarNav');
    const tenantHref = useTenantHref();
    const tenant = useTenantContext();
    // Live badge — fetched lazily; undefined when count is 0 or load fails.
    const calendarBadge = useCalendarBadge(tenant.tenantSlug);

    // Enterprise-grain surfaces (contracts / bins / yield / costs) hang
    // off the GRAIN module — a tenant whose plan doesn't reach the GRAIN
    // tier (or which has it toggled off) never sees the section. An absent
    // `availableModules` (pre-port providers) degrades gracefully to
    // "available" until natural session re-mint.
    const grainAvailable =
        tenant.availableModules === undefined ||
        tenant.availableModules.includes('GRAIN');

    // Exchange — the cross-tenant P2P marketplace. Gated behind the
    // EXCHANGE module (FREE tier, but per-tenant toggleable). Same
    // graceful-degrade convention as the gates above.
    const exchangeAvailable =
        tenant.availableModules === undefined ||
        tenant.availableModules.includes('EXCHANGE');

    // R13-PR7 — tenant sidebar restructure.
    //
    //   Board (standalone, no eyebrow)   home/dashboard
    //   Workspace                        core entities: Asset / Risk / Control
    //   Comply                           daily-cadence work: Plan / Schedule / Review / Docs
    //   Manage                           governance + reporting
    //
    // Renames carry forward to labels only — hrefs (and therefore
    // `data-testid="nav-<slug>"`) stay stable so existing E2E,
    // onboarding-tour, and analytics selectors keep working.
    const sections: NavSectionDef[] = [
        {
            // Board is the home link. No eyebrow — it reads as a
            // single anchor above the grouped nav, mirroring the
            // "home" item pattern in Linear / Stripe / Vercel
            // sidebars.
            items: [
                { href: tenantHref('/dashboard'), label: t('board'), icon: LayoutDashboard },
            ],
        },
        {
            // R13-PR11 — renamed from "Workspace" to "Govern" to
            // better describe the three core entities (assets,
            // risks, controls) as the surfaces compliance teams
            // govern day-to-day, distinct from the daily-cadence
            // work that sits under "Comply".
            id: 'govern',
            title: t('sectionGovern'),
            items: filterVisible([
                { href: tenantHref('/assets'), label: t('asset'), icon: Building2 },
                { href: tenantHref('/locations'), label: t('location'), icon: MapPin },
                // Rent (roadmap 3/3) — the land-obligation register: every
                // аренда/наем lease across the tenant's parcels, the rent roll,
                // and expiring contracts. Sits with the land surfaces (Locations).
                { href: tenantHref('/rent'), label: t('rent'), icon: ScrollText },
                { href: tenantHref('/journal'), label: t('journal'), icon: NotebookPen },
                // Promotions (#12) — global feed of supplier promotions with an
                // "Ask for offer" lead form. Reuses the already-imported Coins
                // glyph (deals/pricing) — no new lucide import. Hidden when the
                // catalogue holds nothing active, for exactly the reason the
                // Events entry above is: the nav entry is permanent, the content
                // is not, and a link to a guaranteed-empty page is worse than no
                // link. `!== false` matches its sibling so an older provider
                // that doesn't set the flag still shows it.
                {
                    href: tenantHref('/offers'),
                    label: t('offers'),
                    icon: Coins,
                    visible: tenant.promotionsAvailable !== false,
                },
                // Climate (#14) — the farm's Open-Meteo weather (current
                // conditions, forecast, spray window) per field. Sits with the
                // field surfaces.
                { href: tenantHref('/climate'), label: t('climate'), icon: CloudSun },
                // Crop Planning — season succession plans (PLANNING
                // module). A simple-mode farm surface (NOT cert-gated), so
                // it's always visible. Reuses the already-imported
                // CalendarIcon (crop planning is calendar/season-shaped) —
                // no new lucide import.
                { href: tenantHref('/planning'), label: t('planting'), icon: CalendarIcon },
                { href: tenantHref('/inventory'), label: t('inventory'), icon: Boxes },
                // Farm Tasks — the operator's field-work queue (FARM_TASK /
                // FIELD_OPERATION). Sits with the agriculture surfaces in
                // Govern. Reuses the already-imported ClipboardList glyph
                // (the task affordance) — no new lucide import.
                { href: tenantHref('/farm-tasks'), label: t('farmTasks'), icon: ClipboardList },
                // The per-parcel satellite AI risk page ("Risk",
                // /farm-risk) is a farm-operations surface, always shown. The
                // GRC Risk Register (/risks) was removed from the sidebar.
                { href: tenantHref('/farm-risk'), label: t('fieldRisk'), icon: AlertTriangle },
            ]),
        },
        {
            // Grain — enterprise-grain operations (contracts / bins /
            // yield / costs). Gated behind the GRAIN module; the whole
            // section is dropped for non-grain tenants by the
            // `sections.filter((s) => !s.title || s.items.length > 0)`
            // tail below.
            id: 'grain',
            title: t('sectionGrain'),
            items: filterVisible([
                { href: tenantHref('/grain/contracts'), label: t('contracts'), icon: Wheat, visible: grainAvailable },
                { href: tenantHref('/grain/bins'), label: t('bins'), icon: Warehouse, visible: grainAvailable },
                { href: tenantHref('/grain/yield'), label: t('yield'), icon: LineChart, visible: grainAvailable },
                { href: tenantHref('/grain/costs'), label: t('costs'), icon: Coins, visible: grainAvailable },
            ]),
        },
        {
            // Exchange — market surfaces. The cross-tenant P2P marketplace is
            // gated behind EXCHANGE, but Trends (global market-price charts +
            // market news) is market data too and sits here, visible to EVERY
            // tenant. Because Trends is ungated the section always renders even
            // for non-Exchange tenants (marketplace hidden, Trends shown).
            id: 'exchange',
            title: t('sectionExchange'),
            items: filterVisible([
                { href: tenantHref('/exchange'), label: t('marketplace'), icon: ArrowLeftRight, visible: exchangeAvailable },
                // Trends (#trends) — global market-price charts (EC + reference
                // benchmark + own-listings index). Visible to every tenant.
                { href: tenantHref('/trends'), label: t('trends'), icon: TrendingUp },
                // News (#news) — aggregated agricultural news feed, decoupled
                // from Trends into its own destination. Visible to every tenant.
                { href: tenantHref('/news'), label: t('news'), icon: Newspaper },
                // Схеми — government support measures (ДФЗ / МЗХ / EC) a farm
                // APPLIES FOR. Sits beside News and Trends: an open call with
                // an application window is market/opportunity information, in
                // the same register as a price move or a policy story.
                //
                // This entry used to point at `/support-schemes` while a
                // separate CERTIFICATION entry owned `/schemes`. The
                // certification catalog was removed with the compliance
                // uproot, so support measures took over the shorter route and
                // there is now exactly ONE "Схеми" destination.
                { href: tenantHref('/schemes'), label: t('schemes'), icon: Coins },
            ]),
        },
        {
            // The former "Comply" section was folded into Manage — its two
            // surfaces (Schedule, Docs) are governance/reporting work like the
            // rest of this group, and a two-item section didn't earn its own
            // eyebrow. They lead the section so their existing position above
            // Schemes / Knowledge is preserved.
            id: 'manage',
            title: t('sectionManage'),
            items: filterVisible([
                {
                    href: tenantHref('/calendar'),
                    label: t('schedule'),
                    icon: CalendarIcon,
                    badge: calendarBadge,
                },
                { href: tenantHref('/evidence'), label: t('docs'), icon: Paperclip },
                // R13-PR12 — Frameworks dropped from the sidebar.
                // The page stays reachable via the Frameworks pill on
                // the Audits page header (R13-PR9) and via the command
                // palette (⌘K → "Frameworks").
                // Knowledge Base — versioned SOPs / guides / reference
                // articles (the Policy feature's twin). Sits under Manage
                // alongside Policy. Reuses the already-imported FileText
                // glyph (document/article affordance) — no new lucide
                // import (the sidebar's icon contract is LucideIcon).
                // NOT gated by CERTIFICATION: the knowledge base is a
                // farm-operations surface (growing guides / SOPs), useful
                // to simple-mode tenants on its own.
                { href: tenantHref('/knowledge'), label: t('knowledge'), icon: FileText },
            ]),
        },
        // Platform support (#12) — curation of the GLOBAL catalogues. Appears
        // ONLY inside the designated platform tenant, so ordinary farms never
        // see that a cross-tenant console exists. `=== true` (not `!== false`)
        // is deliberate: the sibling module flags degrade OPEN because hiding a
        // farm's own feature is the worse failure, whereas here showing a
        // global-catalogue console to the wrong tenant is. The server-side
        // pages and API routes gate independently — this is discoverability,
        // never the security boundary.
        {
            title: t('sectionPlatform'),
            items: filterVisible([
                {
                    href: tenantHref('/admin/promotions'),
                    label: t('platformPromotions'),
                    icon: Coins,
                    visible: tenant.isPlatformTenant === true,
                },
                {
                    href: tenantHref('/admin/companies'),
                    label: t('platformCompanies'),
                    icon: Building2,
                    visible: tenant.isPlatformTenant === true,
                },
            ]),
        },
    ];

    // Defensive: drop any TITLED section whose items were all filtered out
    // (e.g. a future fully module-gated section) so no empty eyebrow
    // renders. The untitled Board section always has an item, so it is
    // never dropped.
    return sections.filter((s) => !s.title || s.items.length > 0);
}

// ─── Sidebar content (shared between desktop sidebar and mobile drawer) ───

interface SidebarContentProps {
    user: { name?: string | null };
    onLogout: () => void;
    onNavClick?: () => void;
    /** Desktop only — when provided, renders the collapse/expand toggle. */
    onToggleCollapse?: () => void;
}

export function SidebarContent({ user, onLogout, onNavClick, onToggleCollapse }: SidebarContentProps) {
    const pathname = usePathname();
    const tc = useTranslations('common');
    const t = useTranslations('sidebarNav');
    const tenant = useTenantContext();
    const tenantHref = useTenantHref();
    const perms = usePermissions();
    const sections = useNavSections();
    const { open: openPalette } = useCommandPalette();
    // Icon-rail mode (desktop). The mobile drawer's provider always reports
    // false, so this whole branch is desktop-only in practice.
    const collapsed = useSidebarCollapsed();

    // Foldable sections. Titled sections start FOLDED, except the one holding
    // the current route (so you always see where you are). The user's explicit
    // open/close choices win over that default and persist across navigation +
    // reloads. Keyed by the stable section id so the map survives a UI-language
    // switch. SSR-safe: `useLocalStorage` returns the `{}` default on the first
    // render and hydrates the stored map in an effect — the active section is
    // open on that first paint either way.
    const [openSections, setOpenSections] = useLocalStorage<Record<string, boolean>>(
        'agrent:sidebar:open-sections:v1',
        {},
    );
    const activeSectionId = sections.find(
        (s) => s.id && s.items.some((item) => pathname.startsWith(item.href)),
    )?.id;

    return (
        <div className="flex flex-col h-full">
            {/* Logo */}
            <div className="p-4 border-b border-border-subtle">
                <div className={collapsed ? 'flex items-center justify-center' : 'flex items-center gap-tight'}>
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--brand-emphasis)] to-[var(--brand-default)] flex items-center justify-center flex-shrink-0 text-content-inverted">
                        <AgrentMark className="h-5 w-5" />
                    </div>
                    {!collapsed && (
                        <span className="text-sm font-semibold text-content-emphasis truncate">{tc('appName')}</span>
                    )}
                </div>
            </div>

            {/* Nav */}
            <nav className="flex-1 p-2 overflow-y-auto" aria-label={t('ariaMain')}>
                {sections.map((section, idx) => {
                    const id = section.id;
                    // Effective open state: the user's stored choice wins;
                    // absent a choice, the active section is open and the rest
                    // are folded.
                    const isOpen = id
                        ? (openSections[id] ?? id === activeSectionId)
                        : true;
                    return (
                        <NavSection
                            key={idx}
                            title={section.title}
                            // R12-PR3 — suppress the top hairline on
                            // the first titled section (the very top
                            // of the sidebar). The solo Board section
                            // sits at idx 0 with no title; the first
                            // titled section is "Govern" at idx 1.
                            isFirst={idx === 0 || sections.findIndex((s) => s.title) === idx}
                            collapsible={Boolean(id)}
                            open={isOpen}
                            onToggleOpen={
                                id
                                    ? () =>
                                          setOpenSections((prev) => ({
                                              ...prev,
                                              [id]: !isOpen,
                                          }))
                                    : undefined
                            }
                        >
                            {section.items.map((item) => (
                                <NavItem
                                    key={item.href}
                                    href={item.href}
                                    icon={item.icon}
                                    label={item.label}
                                    badge={item.badge}
                                    active={pathname.startsWith(item.href)}
                                    onClick={onNavClick}
                                />
                            ))}
                        </NavSection>
                    );
                })}
            </nav>

            {/* The UI-language (BG/EN) toggle lives ONLY in the top-chrome
                account menu now (`user-menu.tsx`). The former mobile-drawer
                language bar was removed per product direction — one home for
                the setting, reached from the account menu on every viewport. */}

            {/* Driver.js product tour — manual restart entry.
                Renders only when the OnboardingTourProvider is
                mounted (i.e. inside the authenticated tenant
                shell). The auto-trigger handles first-login;
                this button is for the "I want to see it again"
                case. Sits above the search bar so the role row
                in the user block below is the literal last line. */}
            {!collapsed && (
                <div className="mx-2">
                    <StartTourButton />
                </div>
            )}

            {/* Roadmap-2 PR-3 — inline command-palette opener.
                Sits below the scrolling nav and above the user
                block. The chrome's `<SearchAnchor>` is the
                primary affordance on desktop; this row is the
                mobile equivalent (chrome is hidden on <md) AND
                a discoverable secondary anchor on desktop. */}
            <button
                type="button"
                onClick={() => {
                    onNavClick?.();
                    openPalette();
                }}
                className={cn(
                    'mx-2 mb-2 flex items-center rounded-lg border border-border-subtle bg-bg-default px-3 py-2 text-xs text-content-muted transition-colors hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                    collapsed ? 'justify-center' : 'gap-tight',
                )}
                aria-label={t('openPalette')}
                data-testid="sidebar-search-anchor"
            >
                <svg
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <circle cx="7" cy="7" r="5" />
                    <path d="M11 11l3 3" />
                </svg>
                {!collapsed && <span className="flex-1 text-left">{t('search')}</span>}
                {!collapsed && (
                    <span
                        className="hidden items-center gap-[2px] rounded border border-border-subtle bg-bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-content-subtle md:flex"
                        aria-hidden="true"
                    >
                        <span>⌘</span>
                        <span>K</span>
                    </span>
                )}
            </button>

            {/* Collapse / expand the desktop sidebar to an icon rail.
                Desktop only — `onToggleCollapse` is undefined in the mobile
                drawer, so this row never renders there. */}
            {onToggleCollapse && (
                <div className="mx-2 mb-2">
                    <button
                        type="button"
                        onClick={onToggleCollapse}
                        aria-label={collapsed ? t('expandSidebar') : t('collapseSidebar')}
                        aria-pressed={collapsed}
                        data-testid="sidebar-collapse-toggle"
                        className={cn(
                            'flex w-full items-center rounded-lg border border-border-subtle bg-bg-default px-3 py-2 text-xs text-content-muted transition-colors hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                            collapsed ? 'justify-center' : 'gap-tight',
                        )}
                    >
                        {collapsed ? (
                            <PanelLeftOpen className="h-4 w-4 shrink-0" aria-hidden="true" />
                        ) : (
                            <PanelLeftClose className="h-4 w-4 shrink-0" aria-hidden="true" />
                        )}
                        {!collapsed && <span className="flex-1 text-left">{t('collapse')}</span>}
                    </button>
                </div>
            )}

            {/* User. Admin + Sign-out sit on a single horizontal
                row, vertically centred against the three-line
                identity (name / tenant / role). The role row is
                the literal last line of the sidebar — the tour
                opener was moved above the search bar so nothing
                renders below the identity. Collapsed: identity text is
                dropped and the icons stack centred in the rail. */}
            <div className="p-3 border-t border-border-subtle">
                <div className={cn('flex gap-tight', collapsed ? 'flex-col items-center' : 'items-center justify-between')}>
                    {!collapsed && (
                        <div className="min-w-0">
                            <p className="text-xs font-medium text-content-default truncate">{user.name}</p>
                            <p className="text-xs text-content-muted truncate">{tenant.tenantName}</p>
                            {/* GAP-CI-77: role uses content-muted (not brand-default).
                                The PwC-orange brand colour on light cream is only
                                4.25:1 — below WCAG AA's 4.5:1 for small text — and
                                the role line is informational, not a brand
                                accent. */}
                            <p className="text-xs text-content-muted">{tenant.role}</p>
                        </div>
                    )}
                    <div className={cn('flex gap-tight', collapsed ? 'flex-col items-center' : 'items-center')}>
                        {perms.admin.view && (
                            <Tooltip content={t('admin')} side={collapsed ? 'right' : 'top'}>
                                <Link
                                    href={tenantHref('/admin')}
                                    aria-label={t('admin')}
                                    id="admin-icon-link-desktop"
                                    data-testid="nav-admin-icon"
                                    className="icon-btn icon-btn-sm"
                                >
                                    <Settings className="size-4" aria-hidden="true" />
                                </Link>
                            </Tooltip>
                        )}
                        <Tooltip content={tc('signOut')} side={collapsed ? 'right' : 'top'}>
                            <button
                                type="button"
                                onClick={onLogout}
                                aria-label={tc('signOut')}
                                data-testid="nav-logout"
                                className="icon-btn icon-btn-sm"
                            >
                                <LogOut className="size-4" aria-hidden="true" />
                            </button>
                        </Tooltip>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ─── Mobile Drawer ───

interface MobileDrawerProps {
    open: boolean;
    onClose: () => void;
    children: React.ReactNode;
}

export function MobileDrawer({ open, onClose, children }: MobileDrawerProps) {
    const pathname = usePathname();
    const t = useTranslations('sidebarNav');

    // Close on route change (always close to avoid stale open state)
    useEffect(() => {
        onClose();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pathname]);

    // Close on Escape — routed through the shared shortcut system so
    // it respects precedence against any other Escape binding that
    // might happen to be active, and so a contributor grepping for
    // shortcut sources finds it via `useKeyboardShortcut` like every
    // other binding in the app.
    //
    // `scope: 'overlay'` + priority 5 means:
    //   - Fires only while the drawer is mounted (via the
    //     `data-sheet-overlay` marker on the backdrop below).
    //   - Beats selection-clear (priority 2) and filter-clear
    //     (priority 1) if both are somehow simultaneously active.
    //   - Loses to any modal stacking above the drawer (those
    //     override via Radix's native Escape inside their portal).
    useKeyboardShortcut('Escape', onClose, {
        enabled: open,
        scope: 'overlay',
        priority: 5,
        description: 'Close navigation drawer',
    });

    // Lock body scroll when open
    useEffect(() => {
        if (open) {
            document.body.style.overflow = 'hidden';
        } else {
            document.body.style.overflow = '';
        }
        return () => { document.body.style.overflow = ''; };
    }, [open]);

    return (
        <>
            {/* Backdrop.
                `data-sheet-overlay` is picked up by the shortcut
                registry's overlay selector, so while the drawer is
                open any `scope: 'global'` shortcut (filter clear,
                selection clear, etc.) stands down automatically. */}
            <div
                className={`
                    fixed inset-0 z-40 bg-black/60 backdrop-blur-sm
                    transition-opacity duration-300
                    ${open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}
                `}
                onClick={onClose}
                aria-hidden="true"
                data-testid="nav-drawer-backdrop"
                data-sheet-overlay={open ? 'true' : undefined}
            />

            {/* Drawer */}
            <div
                className={`
                    fixed inset-y-0 left-0 z-50 w-64 bg-bg-default border-r border-border-subtle
                    transform transition-transform duration-300 ease-in-out
                    ${open ? 'translate-x-0' : '-translate-x-full'}
                `}
                role="dialog"
                aria-modal="true"
                aria-label={t('navMenu')}
                data-testid="nav-drawer"
                data-open={open ? 'true' : 'false'}
            >
                {/* Close button — 44px touch target.
                    Elevation PR-3 — adds canonical focus ring + uses
                    transition-colors (motion-language compliant). */}
                <button
                    type="button"
                    className="absolute top-3 right-3 p-2 rounded-lg text-content-muted hover:text-content-emphasis hover:bg-bg-muted transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                    onClick={onClose}
                    aria-label={t('closeNav')}
                    data-testid="nav-drawer-close"
                >
                    <X className="w-5 h-5" />
                </button>

                {children}
            </div>
        </>
    );
}
