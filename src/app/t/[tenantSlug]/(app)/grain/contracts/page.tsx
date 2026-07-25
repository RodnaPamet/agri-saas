import { getTenantCtx } from '@/app-layer/context';
import { listContracts } from '@/app-layer/usecases/contract';
import { summariseContractBook } from '@/lib/grain/contract-value';
import { CONTRACTED_COMMITMENT_STATUSES } from '@/app-layer/domain/contract-status';
import { ContractsClient } from './ContractsClient';

export const dynamic = 'force-dynamic';

/**
 * Contracts — Server Component.
 *
 * Fetches the contract list server-side via the usecase, then delegates
 * all interaction to the client island (which hydrates React Query with
 * this slice and refetches via the GET API on filter changes). The
 * GRAIN module gate is handled once in the route-group layout.
 */
export default async function GrainContractsPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    const contracts = await listContracts(ctx);
    // Totals come from the SAME page the rows do, so the book figure can
    // never disagree with what is on screen.
    const totals = summariseContractBook(contracts, CONTRACTED_COMMITMENT_STATUSES);

    return (
        <ContractsClient
            initialContracts={JSON.parse(JSON.stringify(contracts))}
            initialTotals={JSON.parse(JSON.stringify(totals))}
            tenantSlug={tenantSlug}
            permissions={{ canWrite: ctx.permissions.canWrite }}
        />
    );
}
