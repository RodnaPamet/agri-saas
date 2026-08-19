'use client';

/**
 * OfflineSyncBar — the shared online/offline + unsynced-work status strip for
 * every offline-capable field surface. Presentational: the host owns a
 * single `useOfflineSync()` instance and passes its values in.
 *
 * ## The copy is the feature
 *
 * This bar used to say "{n} queued", and nothing at all once the count hit
 * zero. That made two very different situations render identically: the
 * server has the work, and the phone deleted the work. An operator reading
 * an empty bar had no way to tell which one they were looking at.
 *
 * So the bar now states WHERE the work is, in those words, and says so in
 * both directions — "saved on this phone" while it is queued, "everything is
 * on the server" once it is not. The silent state is gone; there is always a
 * claim on screen, and it is always the claim the app can actually support.
 */
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { cn } from '@/lib/cn';

export interface OfflineSyncBarProps {
    online: boolean;
    pending: number;
    /** Subset of `pending` that are photo uploads — surfaced distinctly. */
    pendingPhotos?: number;
    /** True when the queue has grown past the point of routine. */
    queueGrowing?: boolean;
    /**
     * Whether this origin's storage is persistent — `true` granted, `false`
     * refused, `null`/undefined not yet asked or not reported. Surfaced only
     * as a caution while work is queued: it is the difference between "this
     * will wait for you" and "the phone may delete this", and an operator
     * deciding whether to detour for signal deserves to know which.
     */
    storagePersisted?: boolean | null;
    onSyncNow: () => void;
    className?: string;
}

export function OfflineSyncBar({
    online,
    pending,
    pendingPhotos = 0,
    queueGrowing = false,
    storagePersisted,
    onSyncNow,
    className,
}: OfflineSyncBarProps) {
    const t = useTranslations('offline');
    // Photos and text mutations queue in the same outbox but read very
    // differently to a field operator ("2 photos will upload" vs "3 marks
    // will sync"), so show them as separate counts.
    const mutations = Math.max(0, pending - pendingPhotos);
    return (
        <div
            data-testid="offline-sync-bar"
            className={cn(
                'rounded-lg border border-border-subtle bg-bg-default px-3 py-2',
                className,
            )}
        >
            <div className="flex items-center justify-between">
                <span className="flex flex-wrap items-center gap-compact text-sm">
                    <StatusBadge variant={online ? 'success' : 'warning'}>
                        {online ? t('online') : t('offline')}
                    </StatusBadge>
                    {mutations > 0 && (
                        <span className="text-content-secondary" data-testid="offline-pending-count">
                            {t('savedOnPhone', { count: mutations })}
                        </span>
                    )}
                    {pendingPhotos > 0 && (
                        <span className="text-content-secondary" data-testid="offline-pending-photos">
                            {t('photosOnPhone', { count: pendingPhotos })}
                        </span>
                    )}
                    {/* The load-bearing half of the distinction: while
                        anything is queued, say plainly that the server does
                        NOT have it; once nothing is, say that it does. An
                        empty bar is not an answer. */}
                    <span
                        className={pending > 0 ? 'text-content-warning' : 'text-content-muted'}
                        data-testid="offline-location-claim"
                    >
                        {pending > 0 ? t('notOnServer') : t('allOnServer')}
                    </span>
                </span>
                {pending > 0 && online && (
                    <Button variant="secondary" size="sm" onClick={onSyncNow}>{t('syncNow')}</Button>
                )}
            </div>
            {queueGrowing && (
                <p className="mt-tight text-xs text-content-warning" data-testid="offline-queue-growing">
                    {t('queueGrowing')}
                </p>
            )}
            {pending > 0 && storagePersisted === false && (
                <p className="mt-tight text-xs text-content-warning" data-testid="offline-storage-unprotected">
                    {t('storageUnprotected')}
                </p>
            )}
        </div>
    );
}

export default OfflineSyncBar;
