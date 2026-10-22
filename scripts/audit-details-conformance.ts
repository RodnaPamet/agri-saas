/**
 * How many stored audit payloads satisfy the CANONICAL schema? — #2109.
 *
 * ## Why measure before enforcing
 *
 * `detailsJson` is written through `AuditDetailsJsonSchema`, one flat object
 * with `.passthrough()`. The canonical `AuditDetailsSchema` — a discriminated
 * union on `category`, each member `.strict()` — is enforced only by
 * `buildAuditEntry`, which has zero call sites in `src`. So stored payloads
 * need not match any declared category, and nobody knows how many do.
 *
 * Pointing `logEvent` at the strict schema without that number is the move to
 * avoid: every call site whose payload has drifted would start throwing
 * `badRequest`, and an audit write that throws is the worst place to discover
 * a mismatch — the thing being recorded is usually already done.
 *
 * So: read-only, counts and examples, no writes. It answers whether #2109 is a
 * small fix or a migration.
 *
 * ## Usage
 *
 *     DATABASE_URL=… npx tsx scripts/audit-details-conformance.ts [--limit 5000]
 *
 * Safe against production: `findMany` with `select` on two columns and a
 * `take`, no mutation, and the payloads are summarised rather than printed —
 * `detailsJson` can carry operator-authored text, so this prints SHAPES (which
 * keys failed, which category) and never values.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { AuditDetailsSchema } from '@/lib/audit/event-schema';

const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

function arg(name: string, fallback: number): number {
    const i = process.argv.indexOf(`--${name}`);
    if (i < 0 || !process.argv[i + 1]) return fallback;
    const n = Number(process.argv[i + 1]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function main(): Promise<void> {
    const limit = arg('limit', 5000);

    const rows = await prisma.auditLog.findMany({
        // `Prisma.DbNull`, not `null`: for a nullable Json column Prisma
        // distinguishes SQL NULL (`DbNull`) from a JSON `null` value
        // (`JsonNull`), and a bare `null` does not typecheck against either.
        where: { detailsJson: { not: Prisma.DbNull } },
        select: { action: true, detailsJson: true },
        orderBy: { createdAt: 'desc' },
        take: limit,
    });

    if (rows.length === 0) {
        // Not a pass. An empty population satisfies every assertion anybody
        // would write on top of this, which is the failure mode to name
        // rather than to report as 100%.
        console.log('NO ROWS with a detailsJson — nothing measured.');
        console.log('That is not evidence of conformance; it is an absence of evidence.');
        return;
    }

    let ok = 0;
    /** category → count, for the rows that PASS. */
    const byCategory = new Map<string, number>();
    /** a compact reason → count, for the rows that FAIL. */
    const failures = new Map<string, number>();
    /** one example action per failure reason, to find a call site from. */
    const exampleAction = new Map<string, string>();

    for (const row of rows) {
        const parsed = AuditDetailsSchema.safeParse(row.detailsJson);
        if (parsed.success) {
            ok++;
            const cat = String((row.detailsJson as { category?: unknown }).category ?? '?');
            byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1);
            continue;
        }
        // Summarise by ISSUE SHAPE, not by value: the path and code of each
        // problem, joined. Two rows failing the same way collapse to one line,
        // which is what makes the output a decision rather than a dump.
        const reason = parsed.error.issues
            .map((i) => `${i.path.join('.') || '<root>'}:${i.code}`)
            .sort()
            .join(' | ')
            .slice(0, 160);
        failures.set(reason, (failures.get(reason) ?? 0) + 1);
        if (!exampleAction.has(reason)) exampleAction.set(reason, row.action);
    }

    const pct = ((ok / rows.length) * 100).toFixed(1);
    console.log(`sampled                ${rows.length} rows (newest first, limit ${limit})`);
    console.log(`conform to canonical   ${ok}  (${pct}%)`);
    console.log(`do NOT conform         ${rows.length - ok}`);

    if (byCategory.size > 0) {
        console.log('\nconforming, by category:');
        for (const [cat, n] of [...byCategory].sort((a, b) => b[1] - a[1])) {
            console.log(`   ${String(n).padStart(6)}  ${cat}`);
        }
    }

    if (failures.size > 0) {
        console.log(`\nfailure shapes (${failures.size} distinct):`);
        for (const [reason, n] of [...failures].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
            console.log(`   ${String(n).padStart(6)}  ${reason}`);
            console.log(`           e.g. action=${exampleAction.get(reason)}`);
        }
        if (failures.size > 25) console.log(`   …and ${failures.size - 25} more shapes`);
    }

    console.log(
        `\nVERDICT: ${
            rows.length - ok === 0
                ? 'every sampled payload conforms — enforcing the canonical schema is a small fix'
                : `${rows.length - ok} sampled payloads would start throwing badRequest if logEvent enforced the canonical schema`
        }`,
    );
}

main()
    .catch((err) => {
        console.error(err instanceof Error ? err.message : err);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
