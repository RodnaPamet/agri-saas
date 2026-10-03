'use client';

import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { useDateFormat } from '@/lib/i18n/use-date-format';
import type { LocationSmartDefaults } from '@/app-layer/usecases/smart-defaults';

/**
 * SmartDefaultsBanner — surfaces today's spray-window suitability and the
 * next crop-plan milestone for THIS field, so the operator sees "is it a
 * good day to spray, and what's coming up" without leaving the location.
 *
 * Both are read from the recall payload (derived from existing weather +
 * planting rows — no ML); the banner renders nothing when neither signal is
 * available, so an unconfigured tenant never sees empty chrome.
 */

const SPRAY_TONE: Record<'GOOD' | 'CAUTION' | 'UNSUITABLE', string> = {
    GOOD: 'text-content-success',
    CAUTION: 'text-content-warning',
    UNSUITABLE: 'text-content-error',
};

const SPRAY_LABEL_KEY: Record<'GOOD' | 'CAUTION' | 'UNSUITABLE', string> = {
    GOOD: 'sprayGood',
    CAUTION: 'sprayCaution',
    UNSUITABLE: 'sprayUnsuitable',
};

const STAGE_LABEL_KEY: Record<'sow' | 'transplant' | 'harvest', string> = {
    sow: 'stageSow',
    transplant: 'stageTransplant',
    harvest: 'stageHarvest',
};

/** Hour-of-day (0–24) → `HH:00` for the spray-window range. */
function formatHour(hour: number): string {
    return `${String(hour).padStart(2, '0')}:00`;
}

export function SmartDefaultsBanner({ data }: { data?: LocationSmartDefaults | null }) {
    const { formatDate } = useDateFormat();
    const t = useTranslations('locations.smart');
    const sprayWindow = data?.sprayWindow ?? null;
    const nextPlanting = data?.nextPlanting ?? null;
    if (!sprayWindow && !nextPlanting) return null;

    return (
        <Card density="compact" className="flex flex-wrap items-center gap-x-section gap-y-tight">
            {sprayWindow && (
                <div className="min-w-0">
                    <p className="text-xs text-content-secondary">{t('sprayWindowToday')}</p>
                    <p className={cn('text-sm font-medium', SPRAY_TONE[sprayWindow.status])}>
                        {t(SPRAY_LABEL_KEY[sprayWindow.status])}
                    </p>
                    {(sprayWindow.windows ?? []).length > 0 ? (
                        <p className="text-xs text-content-secondary">
                            {t('bestSprayWindow')}:{' '}
                            {(sprayWindow.windows ?? [])
                                .map((w) => t('sprayWindowRange', { from: formatHour(w.startHour), to: formatHour(w.endHour) }))
                                .join(', ')}
                        </p>
                    ) : (
                        <p className="text-xs text-content-muted">{t('sprayNoWindowToday')}</p>
                    )}
                    {sprayWindow.reasonCodes.length > 0 && (
                        <p className="text-xs text-content-muted">
                            {sprayWindow.reasonCodes
                                .map((r) => t(`sprayReason.${r.code}`, r.params))
                                .join(' · ')}
                        </p>
                    )}
                </div>
            )}
            {nextPlanting && (
                <div className="min-w-0">
                    <p className="text-xs text-content-secondary">{t('nextCropPlanTask')}</p>
                    <p className="text-sm font-medium">
                        {t(STAGE_LABEL_KEY[nextPlanting.stage])} {nextPlanting.label}
                    </p>
                    <p className="text-xs text-content-muted">{formatDate(new Date(nextPlanting.date))}</p>
                </div>
            )}
        </Card>
    );
}

export default SmartDefaultsBanner;
