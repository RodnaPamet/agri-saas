'use client';
import { useDateFormat } from '@/lib/i18n/use-date-format';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import { AppIcon } from '@/components/icons/AppIcon';
import { useOptimisticUpdate } from '@/components/ui/hooks';
import { PageHeader } from '@/components/layout/PageHeader';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';

type Notification = {
    id: string;
    type: string;
    message: string;
    createdAt: string;
    read: boolean;
};

export default function NotificationsPage() {
    const { formatDateTime } = useDateFormat();
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const t = useTranslations('notifications');
    const [notifications, setNotifications] = useState<Notification[]>([]);

    useEffect(() => {
        fetch(apiUrl('/notifications'))
            .then(r => r.json())
            .then(setNotifications);
    }, [apiUrl]);

    // Epic 60 — mark-read now overlays the read=true state immediately
    // and rolls back if the PATCH fails. The previous implementation
    // awaited the network round-trip before updating the UI, so every
    // click felt ~100-300ms laggy; the overlay is now local-instant.
    // On error, `rolledBackValue` is the prior list which we re-commit
    // so the "unread" styling comes back.
    const { value: optimisticList, update } = useOptimisticUpdate<Notification[]>(
        notifications,
        {
            onError: (_err, rolledBack) => {
                // Revert: caller state never advanced because our commit
                // fn below doesn't call setNotifications on success; the
                // overlay drop + this setState together restore reality.
                setNotifications(rolledBack);
            },
        },
    );

    const markRead = async (id: string) => {
        try {
            await update(
                (prev) => prev.map(n => n.id === id ? { ...n, read: true } : n),
                async () => {
                    const res = await fetch(apiUrl(`/notifications/${id}`), {
                        method: 'PATCH',
                    });
                    if (!res.ok) throw new Error('Mark-read failed');
                    // Commit to canonical state on success — clears the
                    // optimistic overlay since the new reference matches.
                    setNotifications(prev =>
                        prev.map(n => (n.id === id ? { ...n, read: true } : n)),
                    );
                },
            );
        } catch {
            // Swallow — onError already rolled the local list back.
        }
    };

    return (
        <div className="space-y-section animate-fadeIn">
            <PageHeader
                breadcrumbs={[
                    { label: t('crumbDashboard'), href: tenantHref('/dashboard') },
                    { label: t('title') },
                ]}
                title={t('title')}
                description={t('description')}
            />
            <div className="space-y-tight">
                {optimisticList.map(n => (
                    <div key={n.id} className={cn(cardVariants({ density: 'compact' }), 'flex items-start gap-compact', !n.read ? 'border-l-2 border-[var(--brand-default)]' : 'opacity-60')}>
                        <span className="text-lg"><AppIcon name={n.type === 'EVIDENCE' ? 'evidence' : n.type === 'FINDING' ? 'bug' : 'bell'} size={18} /></span>
                        <div className="flex-1">
                            <p className="text-sm text-content-emphasis">{n.message}</p>
                            <p className="text-xs text-content-subtle mt-1">{formatDateTime(n.createdAt)}</p>
                        </div>
                        {!n.read && <Button variant="ghost" size="sm" className="text-xs" onClick={() => markRead(n.id)}>{t('markRead')}</Button>}
                    </div>
                ))}
                {optimisticList.length === 0 && <div className={cn(cardVariants({ density: 'spacious' }), 'text-center text-content-subtle')}>{t('noNotifications')}</div>}
            </div>
        </div>
    );
}
