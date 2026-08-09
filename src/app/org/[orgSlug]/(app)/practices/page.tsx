import { notFound } from 'next/navigation';

import { getOrgCtx } from '@/app-layer/context';
import { listNonPerformingPractices } from '@/app-layer/usecases/portfolio';
import { toPlainJson } from '@/lib/server/to-plain-json';
import { PracticesTable } from './PracticesTable';

/**
 * Epic O-4 — Non-performing practices (cross-tenant).
 *
 * Aggregates `applicability=APPLICABLE` practices whose `status` is
 * NOT `IMPLEMENTED` from every linked tenant, attributed to the
 * source tenant. Each row links to the tenant's own practice detail
 * page where the CISO's auto-provisioned AUDITOR membership unlocks
 * read access under RLS.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
    params: Promise<{ orgSlug: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function OrgPracticesPage({ params, searchParams }: PageProps) {
    const { orgSlug } = await params;
    const sp = await searchParams;

    let ctx;
    try {
        ctx = await getOrgCtx({ orgSlug });
    } catch {
        notFound();
    }

    const cursor = typeof sp.cursor === 'string' ? sp.cursor : undefined;
    const result = await listNonPerformingPractices(ctx, { cursor });

    // Server→client RSC boundary — see `toPlainJson` for rationale.
    return (
        <PracticesTable
            rows={toPlainJson(result.rows)}
            nextCursor={result.nextCursor}
            orgSlug={orgSlug}
        />
    );
}
