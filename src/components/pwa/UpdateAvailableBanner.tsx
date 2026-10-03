'use client';

/**
 * Non-blocking "Update ready — refresh" prompt. Shown by
 * ServiceWorkerRegistrar when a new service worker is parked in the "waiting"
 * state (a deploy landed while the app was open). Tapping Refresh sends
 * SKIP_WAITING to the waiting worker, which activates + claims and the page
 * reloads on `controllerchange`. Until the operator taps it, the running SW
 * keeps serving — a deploy never hot-swaps under someone mid-queue.
 */
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

export interface UpdateAvailableBannerProps {
    onApply: () => void;
}

export function UpdateAvailableBanner({ onApply }: UpdateAvailableBannerProps) {
    const t = useTranslations('pwa.update');
    return (
        <div
            role="status"
            id="sw-update-banner"
            className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-between gap-default border-t border-border-subtle bg-bg-elevated px-4 py-3 md:inset-x-auto md:right-4 md:bottom-4 md:max-w-sm md:rounded-lg md:border"
        >
            <span className="text-sm text-content-muted">{t('ready')}</span>
            <Button size="sm" variant="primary" onClick={onApply}>
                {t('refresh')}
            </Button>
        </div>
    );
}

export default UpdateAvailableBanner;
