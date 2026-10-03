'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useDateFormat } from '@/lib/i18n/use-date-format';
import { Card } from '@/components/ui/card';
import { Heading, TextLink } from '@/components/ui/typography';
import type { AgDashboardJournalItem } from '@/app-layer/usecases/ag-dashboard';

interface RecentJournalCardProps {
    /** Tenant-scoped href to the journal list page (`/t/{slug}/journal`). */
    href: string;
    items: AgDashboardJournalItem[];
}

/**
 * Recent field-journal entries — the agriculture-strip twin of
 * RecentActivityCard. Mirrors its Card + Heading + list-rows + empty-state
 * shape, but reads the journal read-model fetched by <AgDashboardStrip>.
 * Each row links to the journal section; the heading is a section link.
 */
export default function RecentJournalCard({ href, items }: RecentJournalCardProps) {
    const { formatDate } = useDateFormat();
    const t = useTranslations('dashboard.recentJournal');
    return (
        <Card>
            <div className="flex items-baseline justify-between mb-3 gap-tight">
                <Heading level={3} id="recent-journal-heading">
                    {t('title')}
                </Heading>
                <TextLink href={href} tone="muted" className="text-xs">
                    {t('viewAll')}
                </TextLink>
            </div>
            <div
                className="space-y-tight max-h-40 overflow-y-auto overflow-x-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] rounded"
                tabIndex={0}
                role="region"
                aria-labelledby="recent-journal-heading"
            >
                {items.map((entry) => (
                    <Link
                        key={entry.id}
                        href={href}
                        className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-tight text-xs rounded px-1 -mx-1 py-0.5 hover:bg-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                    >
                        <span className="text-content-subtle whitespace-nowrap">
                            {entry.occurredAt ? formatDate(entry.occurredAt) : '—'}
                        </span>
                        <span className="min-w-0 truncate text-content-default font-medium">{entry.title}</span>
                        <span className="text-content-muted whitespace-nowrap">
                            {entry.type.replace(/_/g, ' ').toLowerCase()}
                        </span>
                    </Link>
                ))}
                {items.length === 0 && (
                    <p className="text-content-subtle text-xs">{t('empty')}</p>
                )}
            </div>
        </Card>
    );
}
