'use client';

/**
 * Resolution moment for offline writes that came back 409 STALE_DATA — the job
 * changed on the server while the operator's mark sat queued. Rather than
 * silently clobbering (or silently dropping) the queued edit, each conflict
 * surfaces here with two explicit choices:
 *   • Keep mine  → re-send the edit at the server's current version (it wins).
 *   • Use server → discard the queued edit and take the server's state.
 *
 * Renders nothing when there are no conflicts, so the happy path is invisible.
 */
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import type { OutboxItem } from '@/lib/offline/outbox';
import type { ConflictResolution } from '@/lib/offline/use-offline-sync';

export interface OfflineConflictBannerProps {
    conflicts: OutboxItem[];
    onResolve: (id: string, resolution: ConflictResolution) => void;
    busyId?: string | null;
}

export function OfflineConflictBanner({ conflicts, onResolve, busyId }: OfflineConflictBannerProps) {
    const t = useTranslations('offline.conflict');
    if (!conflicts?.length) return null;

    return (
        <div className="space-y-tight" id="offline-conflicts">
            {conflicts.map((c) => (
                <div
                    key={c.id}
                    role="alert"
                    className="space-y-default rounded-lg border border-border-warning bg-bg-warning px-3 py-3"
                >
                    <div>
                        <p className="text-sm font-medium text-content-warning">{t('title')}</p>
                        <p className="text-sm text-content-muted">{t('description', { label: c.label })}</p>
                    </div>
                    <div className="flex flex-wrap gap-tight">
                        <Button
                            size="sm"
                            variant="primary"
                            loading={busyId === c.id}
                            disabled={busyId === c.id}
                            onClick={() => onResolve(c.id, 'keep-mine')}
                        >
                            {t('keepMine')}
                        </Button>
                        <Button
                            size="sm"
                            variant="secondary"
                            loading={busyId === c.id}
                            disabled={busyId === c.id}
                            onClick={() => onResolve(c.id, 'take-server')}
                        >
                            {t('takeServer')}
                        </Button>
                    </div>
                </div>
            ))}
        </div>
    );
}

export default OfflineConflictBanner;
