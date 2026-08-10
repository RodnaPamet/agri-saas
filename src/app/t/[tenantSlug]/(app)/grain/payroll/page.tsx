import { getTenantCtx } from '@/app-layer/context';
import { listPayrollExpenses } from '@/app-layer/usecases/payroll-expense';
import { PayrollClient } from './PayrollClient';

export const dynamic = 'force-dynamic';

/**
 * Payroll — Server Component.
 *
 * Fetches the payroll-expense list server-side via the usecase, then
 * delegates interaction to the client island. Route base + API base are
 * both `/grain/payroll`. The GRAIN module gate is handled once in the
 * route-group layout (`grain/layout.tsx`) — this page does NOT re-gate.
 */
export default async function GrainPayrollPage({
    params,
    searchParams,
}: {
    params: Promise<{ tenantSlug: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const { tenantSlug } = await params;
    const sp = await searchParams;
    const ctx = await getTenantCtx({ tenantSlug });

    // A shared filtered link must paint filtered on FIRST load — mirrors
    // the yield page's SSR allow-list, and reads the SAME comma-separated
    // params the API does so the two cannot diverge.
    const csv = (key: string): string[] | undefined => {
        const raw = sp[key];
        const value = Array.isArray(raw) ? raw[0] : raw;
        if (!value) return undefined;
        const parts = value.split(',').map((v) => v.trim()).filter(Boolean);
        return parts.length ? parts : undefined;
    };

    const payload = await listPayrollExpenses(ctx, {
        seasonIds: csv('seasonId'),
        plantingIds: csv('plantingId'),
        q: typeof sp.q === 'string' ? sp.q : undefined,
    });

    return (
        <PayrollClient
            initialPayload={JSON.parse(JSON.stringify(payload))}
            tenantSlug={tenantSlug}
            permissions={{ canWrite: ctx.permissions.canWrite }}
        />
    );
}
