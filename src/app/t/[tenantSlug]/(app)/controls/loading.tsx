import {
    SkeletonPageHeader,
    SkeletonFilterToolbar,
    SkeletonDataTable,
} from '@/components/ui/skeleton';
import { getTranslations } from 'next-intl/server';

/**
 * Route-level loading.tsx for /t/[tenantSlug]/practices.
 * Next.js App Router renders this automatically via Suspense
 * while the page component is loading/streaming.
 *
 * Layout matches the real PracticesPage:
 *   - Page header (title + action buttons)
 *   - FilterToolbar (search + pill dropdowns)
 *   - Data table (8 columns × 10 rows)
 */
export default async function PracticesLoading() {
    const t = await getTranslations('practices');
    return (
        <div role="status" aria-live="polite" className="space-y-section animate-fadeIn" aria-busy="true" aria-label={t('loadingAria')}>
            <SkeletonPageHeader />
            <SkeletonFilterToolbar />
            <SkeletonDataTable rows={10} cols={8} />
        </div>
    );
}
