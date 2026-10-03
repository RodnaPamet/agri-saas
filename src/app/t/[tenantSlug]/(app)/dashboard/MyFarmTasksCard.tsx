'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useDateFormat } from '@/lib/i18n/use-date-format';
import { Card } from '@/components/ui/card';
import { Heading, TextLink } from '@/components/ui/typography';
import type { AgDashboardTaskItem } from '@/app-layer/usecases/ag-dashboard';

interface MyFarmTasksCardProps {
    /** Tenant-scoped href to the farm-tasks page (`/t/{slug}/farm-tasks`). */
    href: string;
    items: AgDashboardTaskItem[];
}

/**
 * The caller's farm-work queue — FARM_TASK + FIELD_OPERATION assigned to
 * them, soonest-due first (`listMyFarmTasks`). Always shown in the strip
 * (Tasks is not module-gated). Mirrors RecentActivityCard's chassis.
 */
export default function MyFarmTasksCard({ href, items }: MyFarmTasksCardProps) {
    const { formatDate } = useDateFormat();
    const t = useTranslations('dashboard.myFarmTasks');
    return (
        <Card>
            <div className="flex items-baseline justify-between mb-3 gap-tight">
                <Heading level={3} id="my-farm-tasks-heading">
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
                aria-labelledby="my-farm-tasks-heading"
            >
                {items.map((task) => (
                    <Link
                        key={task.id}
                        href={href}
                        className="flex items-baseline justify-between gap-tight text-xs rounded px-1 -mx-1 py-0.5 hover:bg-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                    >
                        <span className="min-w-0 truncate text-content-default font-medium">{task.title}</span>
                        <span className="text-content-subtle whitespace-nowrap">
                            {task.dueAt ? formatDate(task.dueAt) : task.status.replace(/_/g, ' ').toLowerCase()}
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
