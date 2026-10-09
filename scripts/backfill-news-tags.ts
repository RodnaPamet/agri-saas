/**
 * Tag the news items that already exist (#231, contract §8).
 *
 * `deriveTags` runs on upsert, so the pull tags anything it sees again. It does
 * not see everything: an item older than a feed's current window is never
 * re-fetched, and its `tags` stay `[]` forever. Until this runs, a tag filter
 * under-reports — and the contract is explicit about the consequence: "the
 * first thing a reader does with the new feature is see an empty feed".
 *
 * ## Why this re-tags EVERY row, not just the empty ones
 *
 * The obvious pass is `where: { tags: { equals: [] } }`, and it is wrong here.
 * «Пазар» (`trade`) was added to the vocabulary AFTER the first items were
 * tagged, so rows written this morning carry a tag set computed from a smaller
 * vocabulary. Selecting only empty rows would leave them permanently stale, and
 * the staleness would be invisible — they HAVE tags, just not all of the ones
 * they qualify for.
 *
 * Re-deriving is safe because `deriveTags` is pure and total: same title and
 * summary, same answer, no I/O. So this script is idempotent, and the right
 * mental model is "recompute the column" rather than "fill in the blanks". It
 * is also the mechanism by which any future vocabulary addition is applied.
 *
 * ## Why the report separates two numbers
 *
 * A row can change in two quite different ways, and collapsing them hides the
 * one that matters:
 *
 *   · **gains its first tag** — was `[]`, now has something. This is the
 *     backfill working.
 *   · **tags change** — already had tags, and the set differs. On this run that
 *     is `trade` arriving; on a later run it would be whatever was just added.
 *
 * And the number the owner asked to see first: **how many stay untagged.** That
 * is the one that says whether the tagger is any good. A backfill that reports
 * "8000 rows updated" while half the table matches nothing is not a success,
 * and a single total cannot tell you which you have.
 *
 * ## Safety, following `backfill-journal-title-descriptors.ts`
 *
 *  • **Dry-run by default.** `--apply` is required to write anything.
 *  • **Reversible.** Every prior `tags` value is written to a restore file
 *    BEFORE any update, and `--revert <file>` puts them back verbatim.
 *  • **One column.** Nothing but `tags` is read for the decision or written.
 *    `publishedAt`, `fetchedAt` and `category` are untouched, so this cannot
 *    disturb the feed's ordering or the existing category filter.
 *  • **One transaction.** The table is bounded by the 60-day retention across
 *    four feeds, which the contract notes makes a single transaction viable.
 *
 * `MarketNewsItem` has no `tenantId` — news is global in this product — so
 * this is one pass over one table and there is no per-tenant loop to get
 * wrong, and no RLS context to establish.
 *
 * Usage:
 *   npx tsx scripts/backfill-news-tags.ts                  # report only
 *   npx tsx scripts/backfill-news-tags.ts --apply          # write
 *   npx tsx scripts/backfill-news-tags.ts --revert <file>  # undo
 *
 * ## Not part of the runtime image, and that is deliberate
 *
 * The production build ships no `tsx` and no `scripts/` tree — devDependencies
 * are pruned before the runner stage, and that stage copies only
 * `entrypoint.sh` and `wait-for-migrations.sh` individually (Dockerfile:182).
 * So this cannot be run with `docker compose exec app`, and it is not supposed
 * to be: like `backfill-journal-title-descriptors.ts`, it is an OPERATOR TOOL
 * run against the database, with `DATABASE_URL` pointed at it.
 *
 * Worth knowing why that is the right answer rather than a limitation, because
 * the alternative looks tempting. `scripts/worker.ts` and `scripts/seed.ts` are
 * esbuild-bundled into `dist/` precisely so they CAN run in the container — but
 * both are things production does repeatedly and on its own schedule. A
 * one-off over a countable number of rows is not, and bundling it would put a
 * destructive operator command permanently inside the deployed image where
 * nothing distinguishes it from the app's own entrypoints.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as fs from 'fs';
import * as path from 'path';
import { planNewsTagBackfill } from '../src/lib/news/tag-backfill-plan';

interface RestoreRow {
    id: string;
    tags: string[];
}

async function main() {
    const apply = process.argv.includes('--apply');
    const revertIdx = process.argv.indexOf('--revert');
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
                    prisma.marketNewsItem.update({ where: { id: r.id }, data: { tags: r.tags } }),
                ),
            );
            console.log(`Reverted ${rows.length} row(s).`);
            return;
        }

        const items = await prisma.marketNewsItem.findMany({
            select: { id: true, title: true, summary: true, tags: true, source: true },
            orderBy: { publishedAt: 'desc' },
        });

        // Every decision lives in the planner, which is pure and tested. This
        // script's only remaining jobs are reading, printing and writing.
        const plan = planNewsTagBackfill(items);
        const pct = (n: number) =>
            plan.total === 0 ? '0.0' : ((n / plan.total) * 100).toFixed(1);

        console.log('');
        console.log(`articles in table ........... ${plan.total}`);
        console.log(`would gain their first tag .. ${plan.gainedFirst}`);
        console.log(`tags would CHANGE ........... ${plan.changed}   (already tagged, set differs)`);
        console.log(`already correct ............. ${plan.total - plan.updates.length}`);
        console.log(`would stay untagged ......... ${plan.untagged}  (${pct(plan.untagged)}%)`);
        console.log('');
        console.log('tag distribution (an article can carry several):');
        for (const [tag, n] of [...plan.distribution.entries()].sort((a, b) => b[1] - a[1])) {
            console.log(`  ${tag.padEnd(12)} ${String(n).padStart(5)}  ${pct(n).padStart(5)}%`);
        }
        if (plan.untagged > 0) {
            // Untagged concentrated in ONE feed is a feed whose wording the
            // vocabulary does not cover, which is actionable. Spread evenly it
            // is the tail of general-interest items, which is expected.
            console.log('');
            console.log('untagged by source — a concentration here is a vocabulary gap:');
            for (const [src, n] of [...plan.untaggedBySource.entries()].sort((a, b) => b[1] - a[1])) {
                console.log(`  ${src.padEnd(28)} ${String(n).padStart(5)}`);
            }
        }
        console.log('');

        const updates = plan.updates;

        if (!apply) {
            console.log(`NOTHING WRITTEN. ${updates.length} row(s) would change.`);
            console.log('Re-run with --apply to write.');
            return;
        }

        if (updates.length === 0) {
            console.log('Nothing to write.');
            return;
        }

        const restorePath = path.resolve(
            process.cwd(),
            `news-tags-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
        );
        const restore: RestoreRow[] = updates.map((u) => ({ id: u.id, tags: u.from }));
        // Written and flushed BEFORE the first update, so an interrupted run is
        // still revertible.
        fs.writeFileSync(restorePath, JSON.stringify(restore, null, 2));
        console.log(`Restore file: ${restorePath}`);

        await prisma.$transaction(
            updates.map((u) =>
                prisma.marketNewsItem.update({ where: { id: u.id }, data: { tags: u.to } }),
            ),
        );

        console.log(`Wrote ${updates.length} row(s). Revert with:`);
        console.log(`  npx tsx scripts/backfill-news-tags.ts --revert ${restorePath}`);
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
