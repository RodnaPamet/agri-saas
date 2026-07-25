'use client';

/**
 * Cross-links between the four grain surfaces.
 *
 * Contracts, Yield, Bins and Costs are one workflow — you sell forward,
 * you harvest, you store, you cost it — but each page was a silo
 * reachable only via the sidebar. An operator standing on Contracts
 * asking "did we actually grow this?" had to go back out and start
 * again.
 *
 * Deliberately a plain link row, not a tab bar. These are separate
 * pages with their own URLs and filters, so the tab primitive would be
 * the wrong signal — it implies panels of one view, and it would lose
 * the middle-click / open-in-new-tab affordance an operator comparing
 * two of them wants. (The repo's single-tab-pattern guard bans that
 * primitive in app pages for the same reason.)
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/cn';

export type GrainSection = 'contracts' | 'yield' | 'bins' | 'costs';

const SECTIONS: ReadonlyArray<{ key: GrainSection; path: string }> = [
    { key: 'contracts', path: '/grain/contracts' },
    { key: 'yield', path: '/grain/yield' },
    { key: 'bins', path: '/grain/bins' },
    { key: 'costs', path: '/grain/costs' },
];

export function GrainSectionNav({
    tenantSlug,
    active,
}: {
    tenantSlug: string;
    active: GrainSection;
}) {
    const t = useTranslations('grain.nav');

    return (
        <nav aria-label={t('ariaLabel')} className="flex flex-wrap gap-tight">
            {SECTIONS.map((section) => {
                const isActive = section.key === active;
                return (
                    <Link
                        key={section.key}
                        href={`/t/${tenantSlug}${section.path}`}
                        // The current page is marked but still a link:
                        // removing it would shift the row's layout
                        // between pages, which reads as the nav changing
                        // rather than the selection moving.
                        aria-current={isActive ? 'page' : undefined}
                        className={cn(
                            'rounded-md px-2.5 py-1 text-xs transition-colors',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            isActive
                                ? 'bg-bg-muted font-medium text-content-emphasis'
                                : 'text-content-muted hover:bg-bg-muted hover:text-content-default',
                        )}
                    >
                        {t(section.key)}
                    </Link>
                );
            })}
        </nav>
    );
}
