'use client';

/**
 * UnsyncedWorkBanner — app-wide truth about work that has not reached the
 * server, and about work the phone deleted before it could.
 *
 * ## Why this is global and not another per-page strip
 *
 * `OfflineSyncBar` is mounted by five surfaces. Queue a journal entry, walk
 * to the map or my-work, and the pending count leaves the screen entirely —
 * while the work stays very much queued, and every hour it sits there is
 * another chance for the phone to evict it. "Not behind a menu" has to mean
 * not behind a *route* either.
 *
 * Mounting `useOfflineSync()` here also puts the foreground flush (the
 * `visibilitychange` / `pageshow` drain added alongside this) on EVERY tenant
 * page rather than only the five. On iOS that is the difference between a
 * queue that drains when the operator brings the phone back out of a pocket
 * and one that waits for them to navigate to the right page.
 *
 * ## Two states, and only one of them is dismissible
 *
 *  - **Pending** — a compact pill, above the bottom tab bar so it clears the
 *    one-thumb nav. Disappears on its own when the work lands, because by
 *    then the claim it was making has stopped being true.
 *  - **Lost** — a full-width alert that does NOT disappear on its own. A
 *    successful later sync must never clear it: the work it names is not in
 *    that sync, and clearing it on success is exactly the "resurrect a
 *    partial queue as if complete" failure. Only the operator's explicit
 *    acknowledgement removes it.
 */
import { useTranslations } from 'next-intl';
import { useOfflineSync } from '@/lib/offline/use-offline-sync';
import { Button } from '@/components/ui/button';
import { TriangleWarning } from '@/components/ui/icons/nucleo/triangle-warning';

export function UnsyncedWorkBanner() {
    const t = useTranslations('offline');
    const { pending, pendingPhotos, lost, acknowledgeLostWork, online, durability } = useOfflineSync();

    const mutations = Math.max(0, pending - pendingPhotos);

    return (
        <>
            {lost && (
                <div
                    role="alert"
                    id="offline-lost-work"
                    data-testid="offline-lost-work"
                    className="mb-default rounded-lg border border-border-error bg-bg-error px-4 py-3 text-content-error"
                >
                    <div className="flex items-start gap-compact">
                        <TriangleWarning className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
                        <div className="min-w-0 space-y-tight">
                            <p className="font-medium">{t('lost.title')}</p>
                            <p className="text-sm">
                                {t('lost.description', { count: lost.entries.length })}
                            </p>
                            <div className="text-sm">
                                <p className="font-medium">{t('lost.itemsLabel')}</p>
                                <ul className="list-disc pl-5">
                                    {lost.entries.map((entry) => (
                                        <li key={entry.id}>{entry.label}</li>
                                    ))}
                                </ul>
                            </div>
                            {/* WHY it went, in the operator's words — and
                                the STEP-1 measurement, so a support
                                screenshot carries what the device actually
                                reported instead of a description of it. */}
                            <p className="text-sm" data-testid="offline-storage-verdict">
                                {durability == null || !durability.supported
                                    ? t('storageUnknown')
                                    : durability.persisted
                                      ? t('storageProtected')
                                      : t('storageUnprotected')}
                            </p>
                            <Button variant="secondary" size="sm" onClick={acknowledgeLostWork}>
                                {t('lost.acknowledge')}
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            {pending > 0 && (
                <div
                    data-testid="offline-unsynced-pill"
                    aria-live="polite"
                    className={[
                        // pointer-events-none: purely informational, and a
                        // fixed element over the thumb zone must never
                        // intercept a tap meant for the page underneath.
                        'pointer-events-none fixed left-4 z-30 max-w-[calc(100vw-2rem)] rounded-full',
                        'border border-border-default bg-bg-warning px-3 py-1.5',
                        'text-xs text-content-warning',
                        // Clears the mobile BottomTabBar (h-14 + safe area);
                        // on md+ that bar is hidden so the pill sits low.
                        'bottom-[calc(4rem+env(safe-area-inset-bottom))] md:bottom-4',
                    ].join(' ')}
                >
                    {mutations > 0 && <span>{t('savedOnPhone', { count: mutations })}</span>}
                    {mutations > 0 && pendingPhotos > 0 && <span> · </span>}
                    {pendingPhotos > 0 && <span>{t('photosOnPhone', { count: pendingPhotos })}</span>}
                    <span> · {online ? t('notOnServer') : t('offline')}</span>
                </div>
            )}
        </>
    );
}

export default UnsyncedWorkBanner;
