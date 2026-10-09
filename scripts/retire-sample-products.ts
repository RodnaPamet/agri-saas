/**
 * Retire the seeded «Generic …» sample products (owner, 2026-10-09).
 *
 * 22 of 24 catalogue items on the owner's farm are archetypes — generic
 * stand-ins seeded by `scripts/import-products.ts`, which exist because
 * shipping a real proprietary product-label database is a licensing problem.
 * The design always was that an operator replaces them, and #1078 refuses to
 * COMPLETE a spray line against one, since ДНЕВНИК column 4 asks for a
 * /търговско наименование/.
 *
 * The result was that picking from the catalogue mostly meant picking
 * something that would be refused in the field, at the moment the work was
 * being filed.
 *
 * ## Soft-delete is the whole mechanism, and it was measured
 *
 *     history BEFORE soft-delete: {"name":"Generic Probe"}
 *     history AFTER  soft-delete: {"name":"Generic Probe"}
 *     appears in a deletedAt:null list after: 0
 *
 * Every picker and list reaches items through `listItems`, which filters
 * `deletedAt: null`, so one `UPDATE` removes them from all of them — including
 * the four screens that still render a product list. And a past record reads
 * its product as a relation include with no `deletedAt`, so the ДНЕВНИК and
 * history keep rendering the name.
 *
 * So "keep the ones past records already use" is satisfied by soft delete
 * rather than by exempting them. Owner ruling with that measurement in hand:
 * retire all of them.
 *
 * ## Safety, following `backfill-journal-title-descriptors.ts`
 *
 *  • **Dry-run by default.** `--apply` is required to write anything.
 *  • **Reversible.** Every id is written to a restore file BEFORE the update,
 *    and `--revert <file>` clears `deletedAt` on exactly those rows.
 *  • **One column, one predicate.** Only `deletedAt` is written, and only
 *    where `isArchetype` is true. A real product is never touched, and the
 *    plan counts the untouched ones so that claim is visible rather than
 *    asserted.
 *  • **Idempotent.** A row that already has `deletedAt` is counted and
 *    skipped, never re-stamped — re-running must not move the retirement date.
 *
 * ## Not part of the runtime image, and that is deliberate
 *
 * The production build ships no `tsx` and no `scripts/` tree (devDependencies
 * are pruned before the runner stage, which copies only `entrypoint.sh` and
 * `wait-for-migrations.sh`). So this cannot run via `docker compose exec app`,
 * and is not meant to: like the other backfills, it is an OPERATOR TOOL run
 * against the database with `DATABASE_URL` pointed at it.
 *
 * `scripts/worker.ts` and `scripts/seed.ts` ARE bundled into `dist/` so they
 * can run in the container — but both are things production does repeatedly on
 * its own schedule. A one-off over a countable number of rows is not, and
 * bundling it would leave a destructive operator command permanently inside
 * the deployed image.
 *
 * Usage:
 *   npx tsx scripts/retire-sample-products.ts                  # report only
 *   npx tsx scripts/retire-sample-products.ts --apply          # soft-delete
 *   npx tsx scripts/retire-sample-products.ts --revert <file>  # undo
 *
 * Add `--tenant <slug>` to scope it to one farm; omit it to cover every tenant.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as fs from 'fs';
import * as path from 'path';
import {
    planArchetypeRetirement,
    type ArchetypeCandidate,
} from '../src/lib/catalog/archetype-retirement-plan';

interface RestoreRow {
    id: string;
    name: string;
}

async function main() {
    const apply = process.argv.includes('--apply');
    const revertIdx = process.argv.indexOf('--revert');
    const tenantIdx = process.argv.indexOf('--tenant');
    const tenantSlug = tenantIdx !== -1 ? process.argv[tenantIdx + 1] : undefined;

    // Prisma 7 requires a driver adapter — a bare `new PrismaClient()` throws
    // `PrismaClientInitializationError` before it reaches the database.
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required');
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

    try {
        if (revertIdx !== -1) {
            const file = process.argv[revertIdx + 1];
            if (!file) throw new Error('--revert needs a restore file path');
            const rows: RestoreRow[] = JSON.parse(fs.readFileSync(file, 'utf8'));
            console.log(`Reverting ${rows.length} row(s) from ${file}…`);
            await prisma.$transaction(
                rows.map((r) =>
                    prisma.item.update({ where: { id: r.id }, data: { deletedAt: null } }),
                ),
            );
            console.log(`Reverted ${rows.length} row(s).`);
            return;
        }

        let tenantId: string | undefined;
        if (tenantSlug) {
            const t = await prisma.tenant.findUnique({
                where: { slug: tenantSlug },
                select: { id: true },
            });
            if (!t) throw new Error(`no tenant with slug '${tenantSlug}'`);
            tenantId = t.id;
        }

        // Every item, not only the archetypes — the plan counts the real
        // products it leaves alone, which is what makes "a real product is
        // never touched" a measurement rather than a claim.
        const rows = await prisma.item.findMany({
            where: tenantId ? { tenantId } : {},
            select: {
                id: true,
                name: true,
                category: true,
                isArchetype: true,
                deletedAt: true,
                _count: { select: { operationLines: true, lots: true, costEntries: true } },
            },
            orderBy: { name: 'asc' },
        });

        const candidates: ArchetypeCandidate[] = rows.map((r) => ({
            id: r.id,
            name: r.name,
            category: r.category,
            isArchetype: r.isArchetype,
            deletedAt: r.deletedAt,
            operationLines: r._count.operationLines,
            lots: r._count.lots,
            costEntries: r._count.costEntries,
        }));

        const plan = planArchetypeRetirement(candidates);

        console.log('');
        console.log(`scope ........................ ${tenantSlug ?? 'ALL tenants'}`);
        console.log(`items read ................... ${candidates.length}`);
        console.log(`real products UNTOUCHED ...... ${plan.realProductsUntouched}`);
        console.log(`archetypes ................... ${plan.archetypesSeen}`);
        console.log(`  already retired ............ ${plan.alreadyRetired}  (skipped, not re-stamped)`);
        console.log(`  to retire now .............. ${plan.retire.length}`);
        console.log(`    a past record uses ....... ${plan.referenced}  (kept readable — history is a relation read)`);
        console.log(`    nothing references ....... ${plan.unreferenced}`);
        console.log('');
        console.log('references held by the archetypes being retired:');
        console.log(`  operation lines ............ ${plan.byRelation.operationLines}`);
        console.log(`  inventory lots ............. ${plan.byRelation.lots}`);
        console.log(`  cost entries ............... ${plan.byRelation.costEntries}`);
        if (plan.retire.length) {
            console.log('');
            console.log('to retire:');
            for (const r of plan.retire) {
                console.log(`  ${r.name.padEnd(42)} ${r.category.padEnd(18)} refs=${r.references}`);
            }
        }
        console.log('');

        if (!apply) {
            console.log(`NOTHING WRITTEN. ${plan.retire.length} row(s) would be soft-deleted.`);
            console.log('Re-run with --apply to write.');
            return;
        }

        if (plan.retire.length === 0) {
            console.log('Nothing to write.');
            return;
        }

        const restorePath = path.resolve(
            process.cwd(),
            `archetype-retirement-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
        );
        const restore: RestoreRow[] = plan.retire.map((r) => ({ id: r.id, name: r.name }));
        // Written and flushed BEFORE the first update, so an interrupted run is
        // still revertible.
        fs.writeFileSync(restorePath, JSON.stringify(restore, null, 2));
        console.log(`Restore file: ${restorePath}`);

        const now = new Date();
        await prisma.$transaction(
            plan.retire.map((r) =>
                prisma.item.update({ where: { id: r.id }, data: { deletedAt: now } }),
            ),
        );

        console.log(`Retired ${plan.retire.length} row(s). Revert with:`);
        console.log(`  npx tsx scripts/retire-sample-products.ts --revert ${restorePath}`);
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
