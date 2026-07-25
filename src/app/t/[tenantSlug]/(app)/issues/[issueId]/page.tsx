'use client';
import { useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTenantHref } from '@/lib/tenant-context-provider';

/** Legacy redirect: /issues/[id] → /farm-tasks/[id] */
export default function IssueDetailRedirect() {
    const router = useRouter();
    const params = useParams();
    const tenantHref = useTenantHref();
    const t = useTranslations('issues');
    const issueId = params?.issueId as string;
    useEffect(() => { router.replace(tenantHref(`/farm-tasks/${issueId}`)); }, [router, tenantHref, issueId]);
    return <div className="p-12 text-center text-content-subtle animate-pulse">{t('redirecting')}</div>;
}
