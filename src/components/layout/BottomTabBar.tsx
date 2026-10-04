'use client';

/**
 * BottomTabBar — one-thumb mobile navigation (mobile-shell PR-1).
 *
 * A sticky bottom-tab bar (`md:hidden`) giving field users
 * single-tap reach to the most-used surfaces WITHOUT opening the
 * hamburger drawer. The drawer (`MobileDrawer`) stays as the long
 * tail; this bar is the fast path for the five field surfaces.
 *
 * The tabs follow the user's own saved arrangement (`User.bottomTabOrder`,
 * shared with the iOS app) and fall back to a default order — see
 * `@/lib/nav/resolve-bottom-tabs` for the contract both clients implement.
 *
 * The tabs are NOT a second hard-coded nav list — they are resolved
 * against the live, permission-/module-gated `useNavSections()` (the
 * same source the sidebar + drawer render from). A surface the tenant
 * cannot see (gated out of `useNavSections`) is simply absent from the
 * bar too, so the bar is permission-gated for free and can never show
 * a tab the sidebar wouldn't. Matching by href SUFFIX keeps it robust
 * to the `/t/<slug>` prefix that `tenantHref()` bakes into each href.
 *
 * Only mounted for the `tenant` AppShell variant — `useNavSections`
 * reads tenant context, and these are tenant field surfaces.
 *
 * a11y: each tab is a ≥44px touch target (Apple HIG / WCAG 2.5.5),
 * carries `aria-current="page"` when active (non-visual cue), and the
 * active tab also shows a top accent bar (a position/shape cue, so the
 * active state is never colour-only — WCAG 1.4.1). Honors the device
 * safe-area via the shared `.safe-area-bottom` utility.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/cn';
import { StatusBadge } from '@/components/ui/status-badge';
import { resolveBottomTabs } from '@/lib/nav/resolve-bottom-tabs';
import { useNavSections } from './SidebarNav';

/**
 * One resolved nav item, derived from the nav source's return type so the
 * lucide icon TYPE never has to be imported here directly — the no-lucide
 * ratchet (`tests/guards/no-lucide.test.ts`) keeps new `lucide-react`
 * import sites off the tree. The icon VALUES still flow transparently from
 * the nav data; only the type reference is kept local.
 */
type NavItem = ReturnType<typeof useNavSections>[number]['items'][number];

export interface BottomTabBarProps {
    /**
     * `User.bottomTabOrder` as stored — `null` when never chosen.
     *
     * Read server-side by the tenant layout and threaded through `AppShell`,
     * NOT fetched here. A client fetch would draw the default bar and then
     * re-order it when the response arrived, which is a visible shuffle after
     * paint — the same defect P2.4 removed from the theme.
     */
    savedOrder?: string[] | null;
}

export function BottomTabBar({ savedOrder = null }: BottomTabBarProps) {
    const t = useTranslations('bottomTabBar');
    const pathname = usePathname();
    const sections = useNavSections();

    // The live, already permission- and module-gated nav. Passing it to the
    // resolver is what makes the saved order a PREFERENCE rather than a grant:
    // the resolver can only ever return items that are already in this list,
    // so a stale saved id can reorder and hide, never widen access.
    const items = sections.flatMap((s) => s.items);

    // The default order, the 5-slot clamp, and the null-vs-[] distinction all
    // live in `@/lib/nav/resolve-bottom-tabs`, because iOS renders the same
    // stored value and the two clients have to agree. See its docblock for the
    // agreed table and the one deliberate platform difference.
    const tabs: NavItem[] = resolveBottomTabs(savedOrder, items);

    // No bar rather than an empty strip. Reached two ways: every target
    // surface gated out, or the user deliberately cleared the bar (`[]`).
    if (tabs.length === 0) return null;

    return (
        <nav
            aria-label={t('primary')}
            data-testid="bottom-tab-bar"
            className={cn(
                // Mobile-only, pinned to the viewport bottom, below modals
                // (z-50) and the drawer (z-40/50) but above page content.
                'md:hidden fixed inset-x-0 bottom-0 z-30',
                'flex items-stretch justify-around',
                'border-t border-border-subtle bg-bg-default',
                // Notched-device home-indicator clearance.
                'safe-area-bottom',
            )}
        >
            {tabs.map((tab) => {
                const active = pathname.startsWith(tab.href);
                const Icon = tab.icon;
                // The last path segment is a stable, slug-free test/analytics
                // hook (e.g. "dashboard", "farm-tasks").
                const slug = tab.href.split('/').filter(Boolean).pop() ?? tab.href;
                return (
                    <Link
                        key={tab.href}
                        href={tab.href}
                        aria-current={active ? 'page' : undefined}
                        data-testid={`bottom-tab-${slug}`}
                        data-active={active ? 'true' : 'false'}
                        className={cn(
                            'relative flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1.5',
                            'text-[10px] font-medium leading-none transition-colors duration-150',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-inset',
                            active
                                ? 'text-content-emphasis'
                                : 'text-content-muted hover:text-content-default',
                        )}
                    >
                        {/* Non-colour active cue (WCAG 1.4.1): a top accent
                            bar in addition to the emphasis text + aria-current. */}
                        {active && (
                            <span
                                aria-hidden="true"
                                className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-[var(--brand-default)]"
                            />
                        )}
                        {/* P2.5 — the same `badge` the sidebar renders, from the
                            same gated nav data, so the two can never disagree
                            about a count. Deliberately NOT aria-hidden: it sits
                            inside the link, so it joins the accessible name and
                            a screen reader announces "Календар 3" — matching
                            what `nav-item.tsx` does on the desktop rail.

                            `badge` is already formatted upstream (`undefined`
                            when the count is zero or the fetch failed, '99+'
                            past 99), so there is no empty pill to suppress and
                            no number to cap here. */}
                        {tab.badge != null && (
                            <StatusBadge
                                variant="info"
                                size="sm"
                                // Positioning only. `tests/guards/status-badge-discipline.test.ts`
                                // bans text-size, padding and radius overrides on
                                // StatusBadge — the `size` prop owns those, and
                                // `sm` is already the 10px scale this bar's labels
                                // use, so the overrides were redundant as well as
                                // disallowed.
                                className="absolute right-1/2 top-0.5 translate-x-[0.9rem]"
                            >
                                {tab.badge}
                            </StatusBadge>
                        )}
                        <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                        <span className="max-w-full truncate">{tab.label}</span>
                    </Link>
                );
            })}
        </nav>
    );
}

export default BottomTabBar;
