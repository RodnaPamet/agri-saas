'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTenantHref } from '@/lib/tenant-context-provider';

/** Legacy redirect: /issues/dashboard → /farm-tasks */
export default function IssueDashboardRedirect() {
    const router = useRouter();
    const tenantHref = useTenantHref();
    const t = useTranslations('issues');
    useEffect(() => { router.replace(tenantHref('/farm-tasks')); }, [router, tenantHref]);
    return <div className="p-12 text-center text-content-subtle animate-pulse">{t('redirecting')}</div>;
}
