'use client';

/**
 * Exchange sub-route nav — Browse / My listings / My interests. A link bar
 * (route-based, NOT an in-page TabSelect) styled like the canonical detail
 * tab bar (border-b accent) so it reads as tabs without tripping the
 * single-tab-pattern ratchet.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTenantHref } from '@/lib/tenant-context-provider';
import { cn } from '@/lib/cn';

const ITEMS = [
    { path: '/exchange', labelKey: 'nav.browse', exact: true },
    { path: '/exchange/my-listings', labelKey: 'nav.myListings', exact: false },
    { path: '/exchange/my-interests', labelKey: 'nav.myInterests', exact: false },
] as const;

export function ExchangeNav() {
    const t = useTranslations('exchange');
    const tenantHref = useTenantHref();
    const pathname = usePathname() ?? '';

    return (
        <nav className="flex gap-1 border-b border-border-subtle overflow-x-auto" aria-label="Exchange sections">
            {ITEMS.map((it) => {
                const href = tenantHref(it.path);
                const active = it.exact ? pathname.endsWith(it.path) : pathname.includes(it.path);
                return (
                    <Link
                        key={it.path}
                        href={href}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                            'px-5 py-2.5 text-base font-medium transition border-b-2 whitespace-nowrap',
                            active
                                ? 'border-[var(--brand-default)] text-content-emphasis'
                                : 'border-transparent text-content-muted hover:text-content-emphasis',
                        )}
                    >
                        {t(it.labelKey)}
                    </Link>
                );
            })}
        </nav>
    );
}
