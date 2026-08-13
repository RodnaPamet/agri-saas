import { getTranslations } from 'next-intl/server';
import { getTenantCtx } from '@/app-layer/context';
import { listEvidence } from '@/app-layer/usecases/evidence';
import { EvidenceClient } from './EvidenceClient';

export const dynamic = 'force-dynamic';

// SSR fetch caps at SSR_PAGE_LIMIT rows of evidence.
// The Epic 69 SWR client immediately fetches the unbounded list in
// the background, swapped in by SWR's keepPreviousData. Mirrors
// the PR #146 Tasks pattern.
const SSR_PAGE_LIMIT = 100;

/**
 * Evidence — Server Component wrapper.
 * Fetches evidence server-side, delegates all interaction to client island.
 */
export default async function EvidencePage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;

    // Translations and tenant context are independent — fetch in parallel
    const [t, tc, ctx] = await Promise.all([
        getTranslations('evidence'),
        getTranslations('common'),
        getTenantCtx({ tenantSlug }),
    ]);

    const evidence = await listEvidence(ctx, undefined, { take: SSR_PAGE_LIMIT });

    return (
        <EvidenceClient
            initialEvidence={JSON.parse(JSON.stringify(evidence))}
            tenantSlug={tenantSlug}
            permissions={ctx.permissions}
            translations={{
                title: t('title'),
                listDescription: t('listDescription'),
                evidenceItems: t('evidenceItems', { count: 0 }),
                evidenceTitle: t('evidenceTitle'),
                type: t('type'),
                practice: t('practice'),
                status: t('status'),
                ownerLabel: t('ownerLabel'),
                noEvidence: t('noEvidence'),
                submitForReview: t('submitForReview'),
                approveEvidence: t('approveEvidence'),
                rejectEvidence: t('rejectEvidence'),
                addEvidence: t('addEvidence'),
                createEvidence: t('createEvidence'),
                content: t('content'),
                contentPlaceholder: t('contentPlaceholder'),
                draft: t('draft'),
                submitted: t('submitted'),
                approved: t('approved'),
                rejected: t('rejected'),
                none: tc('none'),
                cancel: tc('cancel'),
                actions: tc('actions'),
            }}
        />
    );
}
