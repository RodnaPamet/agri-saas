/**
 * Rewrite the journal titles the server composed in English (#1073).
 *
 * `recordInputApplication` used to store `Applied ${product} to ${parcel}`.
 * On production that is 9 of the 16 live entries — most of the diary a
 * Bulgarian operator reads. (A 10th, `Applied nitrogen to the north block`,
 * is seeded SAMPLE text with no spray line behind it, so condition 2 below
 * excludes it: it is not a row this composer ever wrote.) Fixing the composer does nothing for rows already written,
 * because a rendered sentence keeps no trace of what it was rendered from.
 *
 * The owner's decision was to rewrite them rather than leave or null them.
 * This is a journal that a regulatory register is generated from, so the
 * script is built to be defensible rather than merely correct:
 *
 *  • **Dry-run by default.** `--apply` is required to write anything.
 *  • **Reversible.** Every prior value is written to a restore file BEFORE
 *    the update, and `--revert <file>` puts them back verbatim.
 *  • **Provably auto-generated rows only.** Three independent conditions must
 *    hold, not one: the entry type, a link to a spray line, and a title
 *    matching the exact composed shape. A title a person typed can satisfy
 *    none of them by accident.
 *  • **Two independent derivations, which must AGREE.** The product and
 *    parcel names are recovered BOTH by parsing the stored English title AND
 *    by reading the linked operation. A row where they disagree is REPORTED
 *    AND SKIPPED, never guessed at.
 *
 * That last rule is the one worth keeping. Re-deriving names from the live
 * operation is the obvious approach and it is subtly wrong: a product or
 * parcel renamed since the entry was filed would silently rewrite history to
 * match the present. Parsing the title alone is also wrong — product names
 * can contain the separator. Requiring both to agree makes a rename visible
 * as a skip instead of invisible as a "successful" rewrite.
 *
 * Usage (from a workstation, DATABASE_URL pointed at the target):
 *
 *     npx tsx scripts/backfill-journal-title-descriptors.ts             # dry run
 *     npx tsx scripts/backfill-journal-title-descriptors.ts --apply
 *     npx tsx scripts/backfill-journal-title-descriptors.ts --revert restore-<ts>.json
 *
 * Not part of the runtime image: the production build ships no `tsx` and no
 * `scripts/` tree. This is an operator tool run against the database, which
 * is right for a one-off over a countable number of rows.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import {
    AUTO_TITLE_KEYS,
    AUTO_TITLE_FALLBACK_LOCALE,
    parseLegacyComposedTitle,
} from '../src/lib/journal/auto-title';
import { translateFor } from '../src/lib/i18n/server-messages';

interface RestoreRow {
    id: string;
    tenantId: string;
    title: string;
    titleKey: string | null;
    titleParams: unknown;
}

async function main() {
    const apply = process.argv.includes('--apply');
    const revertIdx = process.argv.indexOf('--revert');
    const prisma = new PrismaClient();

    try {
        if (revertIdx !== -1) {
            const file = process.argv[revertIdx + 1];
            if (!file) throw new Error('--revert needs a restore file path');
            const rows: RestoreRow[] = JSON.parse(fs.readFileSync(file, 'utf8'));
            console.log(`Reverting ${rows.length} row(s) from ${file}…`);
            for (const r of rows) {
                await prisma.logEntry.update({
                    where: { id: r.id },
                    data: {
                        title: r.title,
                        titleKey: r.titleKey,
                        titleParams:
                            r.titleParams === null || r.titleParams === undefined
                                ? Prisma.DbNull
                                : (r.titleParams as Prisma.InputJsonValue),
                    },
                });
            }
            console.log(`Reverted ${rows.length} row(s).`);
            return;
        }

        // Condition 1 + 2: the type, and a link to the spray line that
        // produced it. Condition 3 (the title shape) is applied in code so a
        // near-miss can be REPORTED rather than silently excluded by SQL.
        const candidates = await prisma.logEntry.findMany({
            where: {
                type: 'INPUT_APPLICATION',
                operationParcelId: { not: null },
                titleKey: null,
            },
            select: {
                id: true,
                tenantId: true,
                title: true,
                titleKey: true,
                titleParams: true,
                operationParcelId: true,
            },
            orderBy: { id: 'asc' },
        });

        const lineIds = candidates
            .map((c) => c.operationParcelId)
            .filter((v): v is string => Boolean(v));
        const lines = lineIds.length
            ? await prisma.operationParcel.findMany({
                  where: { id: { in: lineIds } },
                  select: {
                      id: true,
                      product: { select: { name: true } },
                      parcel: { select: { name: true } },
                  },
              })
            : [];
        const byLine = new Map(lines.map((l) => [l.id, l]));

        const updates: { row: RestoreRow; title: string; params: { product: string; parcel: string } }[] = [];
        const skipped: string[] = [];

        for (const c of candidates) {
            const parsed = parseLegacyComposedTitle(c.title);
            if (!parsed) {
                skipped.push(`${c.id}: title is not the composed English shape — "${c.title}"`);
                continue;
            }
            const { product: parsedProduct, parcel: parsedParcel } = parsed;
            const line = c.operationParcelId ? byLine.get(c.operationParcelId) : undefined;
            if (!line) {
                skipped.push(`${c.id}: linked operation line is gone — cannot corroborate`);
                continue;
            }
            const liveProduct = line.product?.name ?? null;
            const liveParcel = line.parcel?.name ?? null;

            // The corroboration. Disagreement means a rename since filing.
            if (liveProduct !== parsedProduct || liveParcel !== parsedParcel) {
                skipped.push(
                    `${c.id}: title and live operation DISAGREE — ` +
                        `title says (${parsedProduct} / ${parsedParcel}), ` +
                        `operation says (${liveProduct} / ${liveParcel}). ` +
                        `Left untouched: rewriting would replace what was filed with what is current.`,
                );
                continue;
            }

            const params = { product: parsedProduct, parcel: parsedParcel };
            const title = await translateFor(
                AUTO_TITLE_FALLBACK_LOCALE,
                AUTO_TITLE_KEYS.inputApplication,
                params,
            );
            updates.push({
                row: {
                    id: c.id,
                    tenantId: c.tenantId,
                    title: c.title,
                    titleKey: c.titleKey,
                    titleParams: c.titleParams,
                },
                title,
                params,
            });
        }

        console.log(`Candidates: ${candidates.length}`);
        console.log(`To rewrite: ${updates.length}`);
        console.log(`Skipped:    ${skipped.length}`);
        for (const s of skipped) console.log(`  SKIP ${s}`);
        for (const u of updates) {
            console.log(`  ${u.row.id}\n    from: ${u.row.title}\n    to:   ${u.title}`);
        }

        if (!apply) {
            console.log('\nDry run — nothing written. Re-run with --apply.');
            return;
        }
        if (updates.length === 0) {
            console.log('\nNothing to do.');
            return;
        }

        // Restore file FIRST. A rewrite of a filed register that cannot be
        // undone is not a rewrite, it is a loss.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const restorePath = path.resolve(`journal-title-restore-${stamp}.json`);
        fs.writeFileSync(restorePath, JSON.stringify(updates.map((u) => u.row), null, 2));
        console.log(`\nRestore file written: ${restorePath}`);

        for (const u of updates) {
            await prisma.logEntry.update({
                where: { id: u.row.id },
                data: {
                    title: u.title,
                    titleKey: AUTO_TITLE_KEYS.inputApplication,
                    titleParams: u.params,
                },
            });
        }
        console.log(`Rewrote ${updates.length} row(s). Revert with:`);
        console.log(`  npx tsx scripts/backfill-journal-title-descriptors.ts --revert ${restorePath}`);
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
