/**
 * scripts/module-usage-report.ts — operator report for the product-identity
 * decision (docs/adr/0001-product-identity.md).
 *
 * READ-ONLY. For each tenant, prints the enabled modules and bounded row counts
 * per domain (agri / core), so an operator can see — per tenant — how much of
 * the compliance core is actually populated vs the agriculture surface. Pair it
 * with the module × device telemetry (module.access.count) for the full picture.
 *
 * Runs with a direct PrismaClient (migration/superuser role) so it sees every
 * tenant's rows without binding RLS context — a global read, not a tenant one.
 *
 *   npx tsx scripts/module-usage-report.ts
 */
import { PrismaClient } from '@prisma/client';

// Representative tenant-scoped models per domain. Counts are summed per domain;
// a model that doesn't exist / isn't tenant-scoped is skipped (best-effort).
const DOMAIN_MODELS: Record<'agri' | 'core', string[]> = {
    agri: ['parcel', 'farmJournalEntry', 'inventoryItem', 'cropPlan', 'grainLot', 'grainBin', 'sprayRecord'],
    core: ['practice', 'risk', 'vendor', 'evidence', 'policy', 'finding', 'auditCycle', 'framework'],
};

async function countModel(prisma: PrismaClient, model: string, tenantId: string): Promise<number | null> {
    const delegate = (prisma as unknown as Record<string, { count?: (a: unknown) => Promise<number> }>)[model];
    if (!delegate?.count) return null;
    try {
        return await delegate.count({ where: { tenantId } });
    } catch {
        return null; // not tenant-scoped / no such column — skip
    }
}

async function main(): Promise<void> {
    const prisma = new PrismaClient();
    try {
        const tenants = await prisma.tenant.findMany({
            select: { id: true, slug: true, name: true },
            orderBy: { createdAt: 'asc' },
        });

        console.log(`\nModule usage report — ${tenants.length} tenant(s)\n${'='.repeat(72)}`);

        for (const t of tenants) {
            const settings = await prisma.tenantModuleSettings.findUnique({
                where: { tenantId: t.id },
                select: { enabledModules: true },
            });
            const enabled = settings?.enabledModules ?? [];

            const domainCounts: Record<string, number> = {};
            for (const [domain, models] of Object.entries(DOMAIN_MODELS)) {
                let total = 0;
                for (const m of models) {
                    const n = await countModel(prisma, m, t.id);
                    if (n != null) total += n;
                }
                domainCounts[domain] = total;
            }

            console.log(`\n${t.name}  (${t.slug})`);
            console.log(`  enabled modules : ${enabled.length ? enabled.join(', ') : '(none)'}`);
            console.log(`  agri rows       : ${domainCounts.agri}`);
            console.log(`  core rows       : ${domainCounts.core}`);
        }
        console.log(`\n${'='.repeat(72)}\nDone.\n`);
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((err) => {
    console.error('module-usage-report failed:', err);
    process.exit(1);
});
