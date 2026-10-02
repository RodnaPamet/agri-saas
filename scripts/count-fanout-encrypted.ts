/**
 * Pre-flight for #1222: how many rows does the `'*'` fan-out have encrypted,
 * per (model, field), on the database this is pointed at?
 *
 * ## Why this exists, and why it has to be its own thing
 *
 * `encryption-middleware.ts`'s `'*'` fan-out matches field NAMES across the
 * whole manifest, so a model that is NOT in `ENCRYPTED_FIELDS` gets a column
 * encrypted anyway when it happens to carry a manifest field name. Narrowing
 * the fan-out is the fix — but narrowing also stops the middleware
 * DECRYPTING those columns, so any row already holding `v2:` becomes
 * unreadable to everyone, silently: no error, no log, the value simply reads
 * as ciphertext.
 *
 * `countMisplacedV2` in `global-key-rotation.ts` will not answer this. It
 * counts `v2:` only over `v2RepairColumns()`, driven by
 * `V2_REPAIR_TENANT_COLUMN` — one entry today (`ExchangeMessage`). A field
 * narrowed to plaintext is outside its view by construction, so the orphan is
 * invisible in both directions: not decrypted, not detected.
 *
 * ## Two deliberate choices
 *
 * **Raw `pg`, not the Prisma client.** The app client carries
 * `withEncryptionExtension`, which would DECRYPT these columns on read and
 * hide the very thing being counted. A count through the app client would
 * report plaintext everywhere and look like good news.
 *
 * **The (model, field) pairs are DERIVED, never listed.** They come from
 * `ENCRYPTED_FIELDS` plus the Prisma schema, computed at run time. A hardcoded
 * list would go stale the moment the manifest changes — which it did while
 * this change was being written: `ExchangeMessage` moved INTO the manifest in
 * #1248, taking the set from 19 pairs to 18. A list would have kept counting a
 * model that is no longer affected and under-reported the rest.
 *
 * ## Usage
 *
 *   DATABASE_URL=postgresql://... npx tsx scripts/count-fanout-encrypted.ts
 *
 * Reports; never writes, and never gates. A non-zero `v2` on a field slated
 * for plaintext is a decision, not a build failure.
 */
import { Client } from 'pg';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

export interface Pair {
    model: string;
    field: string;
    tenantScoped: boolean;
}

/** The manifest, parsed from source rather than imported, so this runs standalone. */
function manifest(): Record<string, string[]> {
    const src = fs.readFileSync(path.join(ROOT, 'src/lib/security/encrypted-fields.ts'), 'utf8');
    const block = /ENCRYPTED_FIELDS[^=]*=\s*\{([\s\S]*?)\n\}/.exec(src);
    if (!block) throw new Error('could not locate ENCRYPTED_FIELDS — the parser is stale');
    const out: Record<string, string[]> = {};
    for (const m of block[1].matchAll(/^ {4}(\w+)\s*:\s*\[([^\]]*)\]/gm)) {
        out[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map((f) => f[1]);
    }
    if (Object.keys(out).length === 0) throw new Error('parsed an EMPTY manifest — refusing to report zero');
    return out;
}

/** Every non-manifest (model, field) the fan-out can reach, derived from the schema. */
export function affectedPairs(): Pair[] {
    const mani = manifest();
    const flat = new Set(Object.values(mani).flat());
    const dir = path.join(ROOT, 'prisma/schema');
    const src = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.prisma'))
        .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
        .join('\n');
    const pairs: Pair[] = [];
    for (const m of src.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
        const [, model, body] = m;
        if (model in mani) continue;
        const tenantScoped = /^\s*tenantId\s/m.test(body);
        for (const f of body.matchAll(/^\s{2,}(\w+)\s+\S+/gm)) {
            if (flat.has(f[1])) pairs.push({ model, field: f[1], tenantScoped });
        }
    }
    if (pairs.length === 0) throw new Error('derived ZERO affected pairs — the schema parser is stale');
    return pairs;
}

export interface PairCount extends Pair {
    rows: number;
    v2: number;
    v1: number;
    /** Set when the table could not be read at all. NOT the same as zero. */
    error?: string;
}

/**
 * Count `v2:`/`v1:` per affected pair against an OPEN client.
 *
 * Exported so the suite can drive it against the live per-worker test database.
 * That is not tidiness: the slot DB (`agri_saas_test_c<hash>_w<N>`) exists only
 * for the duration of a run, so an external invocation cannot reach it — and
 * running this script against the BASE database instead reports a different
 * row set entirely, which is exactly the false negative that caught me while
 * writing it. The only place a positive control for this counter can live is
 * inside a test.
 */
export async function countAffected(client: Client, pairs: Pair[] = affectedPairs()): Promise<PairCount[]> {
    const out: PairCount[] = [];
    for (const p of pairs) {
        const sql =
            `SELECT count(*)::int AS rows, ` +
            `count(*) FILTER (WHERE "${p.field}" LIKE 'v2:%')::int AS v2, ` +
            `count(*) FILTER (WHERE "${p.field}" LIKE 'v1:%')::int AS v1 ` +
            `FROM "${p.model}"`;
        try {
            const r = await client.query(sql);
            const { rows, v2, v1 } = r.rows[0] as { rows: number; v2: number; v1: number };
            out.push({ ...p, rows, v2, v1 });
        } catch (err) {
            // A table that cannot be read is UNKNOWN, never zero.
            out.push({ ...p, rows: 0, v2: 0, v1: 0, error: (err as Error).message });
        }
    }
    return out;
}

/**
 * The same counts as ONE query, for a database this script cannot dial.
 *
 * Production's Postgres is inside the VM's compose stack and the runtime image
 * ships neither `tsx` nor `scripts/`, so the script cannot run there. Emitting
 * the SQL keeps the DERIVATION here — where it is computed from the manifest
 * and the schema, and cannot go stale — while the execution happens wherever
 * the database actually is. Hand-writing the query at the far end would throw
 * away the only property that makes this trustworthy.
 *
 * Read-only by construction: counts and a literal label per row, no column
 * values, so a transcript of the output carries no row content.
 */
export function emitSql(pairs: Pair[] = affectedPairs()): string {
    return pairs
        .map(
            (p) =>
                `SELECT '${p.model}.${p.field}' AS target, ` +
                // The counts below are WHOLE-DATABASE -- `FROM \"Model\"`, no
                // `WHERE tenantId`. This column therefore describes the MODEL
                // (does it carry a tenantId at all), never the count's scope.
                // It read `AS scope` with the value `tenant`, next to a count,
                // which invites exactly one reading: "one row, in one tenant".
                // A peer read `Location.description v2=1` off this output and
                // began writing up a live production orphan before checking
                // the manifest. Whole-database is CORRECT here -- a blast
                // radius is a total -- so the query is right and the label was
                // the defect.
                `'${p.tenantScoped ? 'tenant-scoped model' : 'tenantless model'}' AS model_shape, ` +
                `count(*)::int AS rows, ` +
                `count(*) FILTER (WHERE "${p.field}" LIKE 'v2:%')::int AS v2, ` +
                `count(*) FILTER (WHERE "${p.field}" LIKE 'v1:%')::int AS v1 ` +
                `FROM "${p.model}"`,
        )
        .join('\nUNION ALL ') + '\nORDER BY v2 DESC, target;';
}

async function main(): Promise<void> {
    if (process.argv.includes('--sql')) {
        console.log(emitSql());
        return;
    }

    const connectionString = process.env.DATABASE_URL ?? process.env.DIRECT_DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL (or DIRECT_DATABASE_URL) is required');

    const pairs = affectedPairs();
    const client = new Client({ connectionString });
    await client.connect();

    console.log(`\n  ${pairs.length} affected (model, field) pairs, derived from the manifest + schema\n`);
    // `rows`/`v2`/`v1` are ALL-ROWS counts; the second column describes the
    // model, not the count. See the note in `emitSql`.
    console.log(`  ${'model.field'.padEnd(40)} ${'model'.padEnd(8)} ${'rows*'.padStart(6)} ${'v2*'.padStart(5)} ${'v1*'.padStart(5)}`);
    console.log(`  ${'-'.repeat(40)} ${'-'.repeat(8)} ${'-'.repeat(6)} ${'-'.repeat(5)} ${'-'.repeat(5)}`);
    console.log(`  ${' '.repeat(40)} ${' '.repeat(8)} * whole-database, never tenant-filtered`);

    const counts = await countAffected(client, pairs);
    let totalV2 = 0;
    const withV2: string[] = [];
    for (const c of counts) {
        if (c.error) {
            console.log(`  ${`${c.model}.${c.field}`.padEnd(40)} ${'?'.padEnd(8)} ${'ERROR'.padStart(6)}  ${c.error.slice(0, 44)}`);
            continue;
        }
        totalV2 += c.v2;
        if (c.v2 > 0) withV2.push(`${c.model}.${c.field} (${c.v2})`);
        console.log(
            `  ${`${c.model}.${c.field}`.padEnd(40)} ${(c.tenantScoped ? 'tenant' : 'GLOBAL').padEnd(8)} ` +
                `${String(c.rows).padStart(6)} ${String(c.v2).padStart(5)} ${String(c.v1).padStart(5)}`,
        );
    }

    console.log(
        `\n  TOTAL v2 rows across the fan-out's reach: ${totalV2}` +
            (totalV2 === 0
                ? '\n  Nothing to migrate: narrowing orphans no row on this database.\n'
                : `\n  These fields hold ciphertext that narrowing would ORPHAN — decide each before narrowing:\n    ${withV2.join('\n    ')}\n`),
    );
    await client.end();
}

if (require.main === module) {
    main().catch((err) => {
        console.error(`[count-fanout-encrypted] ${(err as Error).message}`);
        process.exit(1);
    });
}
