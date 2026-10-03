/**
 * Re-hash every lookup hash onto the CURRENT `LOOKUP_HMAC_KEY`. #1237, P1.3.
 *
 * ## Why this is the last thing blocking `LOOKUP_HMAC_KEY_PREVIOUS`
 *
 * P1.1 made a lookup-key rotation readable: `hashForLookupCandidates` returns
 * the hash under the primary key AND under the previous one, so a read finds a
 * row whichever key hashed it. #1251 converted the sixteen call sites that
 * computed the hash themselves and so could never use that fallback.
 *
 * Reading through is not finishing. Nothing REWRITES the stored hash, so every
 * row keeps its old value indefinitely and the previous key can never be
 * removed — the fallback becomes permanent, and a key kept forever is a key
 * that was never really rotated. This sweep is what ends that.
 *
 * ## The stop condition here is MEASURABLE, unlike the KEK sweep's
 *
 * Worth stating because the sibling case is a trap. For the master KEK,
 * `encryptField` always emits a `v1:` prefix, so a re-encrypted value is still
 * `v1:` and `WHERE col LIKE 'v1:%'` can never reach zero — "remove _PREVIOUS
 * once no v1 rows remain" is unmeasurable, which is why
 * `isV1UnderPrimaryKey` has to try a decrypt per row.
 *
 * A lookup hash has no such problem. A row is current iff
 * `storedHash === hashForLookup(plaintext)`, which is decidable per row. So
 * `countStaleLookupHashes()` is an honest completion signal and
 * `lookupPreviousKeyRetirable()` can be trusted.
 *
 * The cost is that deciding it requires the PLAINTEXT, so each row costs one
 * decrypt — the same shape as the KEK sweep's counter, and the same reason:
 * Postgres cannot answer "is this hash the one this value would produce now".
 *
 * ## A collision is an ERROR, never a swallow
 *
 * `User.emailHash` is `@unique`. Re-hashing changes the value, so an UPDATE can
 * fail 23505 — and that failure means two rows claim one address, which is
 * exactly the duplicate-`User` defect #1237 exists to prevent. Reporting it
 * with the row id is the only useful response; continuing silently would leave
 * an operator with a sweep that says "done" over a database that is not.
 */
import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { decryptField, hashForLookup, isLookupKeyPinned } from '@/lib/security/encryption';
import { internal } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';

/** One column holding a deterministic lookup hash, plus its ciphertext source. */
export interface LookupHashColumn {
    model: string;
    table: string;
    /** The column holding the ciphertext the hash is derived from. */
    encryptedColumn: string;
    /** The column holding the hash. */
    hashColumn: string;
}

/**
 * The columns this sweep owns.
 *
 * Declared rather than derived from `PII_FIELD_MAP`, deliberately. That map is
 * keyed by PRISMA FIELD names and carries a `mapped` flag deciding whether the
 * plaintext column still exists; reading it here would couple the sweep to a
 * shape that is mid-migration for exactly these models. Two entries, each
 * written down with its physical column names, is both clearer and harder to
 * get silently wrong — and `assertLookupColumns` proves every name against the
 * live schema before any row is touched.
 */
export const LOOKUP_HASH_COLUMNS: readonly LookupHashColumn[] = [
    {
        model: 'User',
        table: 'User',
        encryptedColumn: 'emailEncrypted',
        hashColumn: 'emailHash',
    },
    {
        model: 'UserIdentityLink',
        table: 'UserIdentityLink',
        encryptedColumn: 'emailAtLinkTimeEncrypted',
        hashColumn: 'emailAtLinkTimeHash',
    },
];

/** Reject an identifier that is not a bare column/table name. */
function assertIdentifier(name: string, what: string): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw internal(`lookup-rehash: unsafe ${what} '${name}'`);
    }
}

/**
 * Prove every declared name exists before touching a row.
 *
 * The same reasoning as `assertSweepableColumns` in the KEK sweep: skipping
 * what cannot be found is how a sweep reports success over half the data. It
 * also checks `id`, because the keyset cursor addresses rows by it — a model
 * without one would fail mid-sweep, after some rows had been rewritten. (That
 * is not hypothetical: #1254 fixed exactly that for the KEK sweep when
 * `FeatureFlag`, which keys on `key`, entered its set.)
 */
export async function assertLookupColumns(
    columns: readonly LookupHashColumn[] = LOOKUP_HASH_COLUMNS,
): Promise<void> {
    if (columns.length === 0) {
        throw internal('lookup-rehash: zero columns — sweeping nothing would report success');
    }
    for (const c of columns) {
        assertIdentifier(c.table, 'table');
        assertIdentifier(c.encryptedColumn, 'encrypted column');
        assertIdentifier(c.hashColumn, 'hash column');
    }
    const tables = [...new Set(columns.map((c) => c.table))];
    const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string; column_name: string }>>(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
        tables,
    );
    const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    const missing: string[] = [];
    for (const c of columns) {
        for (const col of [c.encryptedColumn, c.hashColumn, 'id']) {
            if (!have.has(`${c.table}.${col}`)) missing.push(`${c.table}.${col}`);
        }
    }
    if (missing.length > 0) {
        throw internal(
            `lookup-rehash: refusing to sweep — these columns do not exist: ${missing.join(', ')}`,
        );
    }
}

export interface StaleCount {
    model: string;
    hashColumn: string;
    /** Rows with a non-null hash and non-null ciphertext. */
    total: number;
    /** Of those, rows whose stored hash is not what the current key produces. */
    stale: number;
    /** Rows whose ciphertext could not be decrypted under any configured key. */
    undecryptable: number;
}

/**
 * How many stored hashes are NOT what the current key would produce.
 *
 * Zero is the signal that `LOOKUP_HMAC_KEY_PREVIOUS` can be removed. Counted in
 * Node because the question is "would this value hash to this", which is an
 * HMAC over a decrypted plaintext and not something Postgres can answer.
 */
export async function countStaleLookupHashes(
    columns: readonly LookupHashColumn[] = LOOKUP_HASH_COLUMNS,
): Promise<{ total: number; stale: number; perColumn: StaleCount[] }> {
    await assertLookupColumns(columns);

    const perColumn: StaleCount[] = [];
    let total = 0;
    let stale = 0;

    for (const c of columns) {
        const rows = await prisma.$queryRawUnsafe<Array<{ h: string; e: string }>>(
            `SELECT "${c.hashColumn}" AS h, "${c.encryptedColumn}" AS e
               FROM "${c.table}"
              WHERE "${c.hashColumn}" IS NOT NULL AND "${c.encryptedColumn}" IS NOT NULL`,
        );
        let columnStale = 0;
        let undecryptable = 0;
        for (const row of rows) {
            let plaintext: string;
            try {
                plaintext = decryptField(row.e);
            } catch {
                // Counted, not thrown: a row nobody can decrypt is a different
                // problem from a row on the old hash key, and conflating them
                // would make the retirable verdict wrong in the dangerous
                // direction.
                undecryptable++;
                continue;
            }
            if (row.h !== hashForLookup(plaintext)) columnStale++;
        }
        perColumn.push({
            model: c.model,
            hashColumn: c.hashColumn,
            total: rows.length,
            stale: columnStale,
            undecryptable,
        });
        total += rows.length;
        stale += columnStale;
    }

    return { total, stale, perColumn };
}

export interface RehashResult {
    model: string;
    hashColumn: string;
    scanned: number;
    rehashed: number;
    alreadyCurrent: number;
    errors: number;
    /** Row ids whose UPDATE collided with the unique constraint. */
    collisions: string[];
}

/**
 * Rewrite every stale hash onto the current key.
 *
 * Idempotent: a row already current is counted and skipped, so a second pass
 * reports `rehashed: 0`. Safe to run repeatedly, which matters because the
 * honest operational shape is "run until `stale` is zero".
 */
export async function rehashLookupHashes(opts?: {
    batchSize?: number;
    columns?: readonly LookupHashColumn[];
}): Promise<RehashResult[]> {
    const columns = opts?.columns ?? LOOKUP_HASH_COLUMNS;
    const batchSize = Math.min(Math.max(opts?.batchSize ?? 500, 1), 5000);
    await assertLookupColumns(columns);

    if (!isLookupKeyPinned()) {
        // Not an error: with no separate lookup key the hashes derive from the
        // KEK, and a KEK rotation does not move them (that is P1.1's whole
        // mechanism). Sweeping would rewrite every row to the value it already
        // holds.
        logger.info('lookup-rehash.no_pinned_key', {
            component: 'lookup-rehash',
            detail:
                'LOOKUP_HMAC_KEY is not configured, so hashes derive from the KEK ' +
                'and nothing can be stale. Nothing to do.',
        });
    }

    const out: RehashResult[] = [];

    for (const c of columns) {
        const result: RehashResult = {
            model: c.model,
            hashColumn: c.hashColumn,
            scanned: 0,
            rehashed: 0,
            alreadyCurrent: 0,
            errors: 0,
            collisions: [],
        };

        // Keyset cursor on `id`, not OFFSET: rows are UPDATEd as we go, and an
        // OFFSET walk over a changing set skips rows. The predicate does not
        // narrow as we rewrite (a rehashed row still has a non-null hash), so
        // an ascending cursor is both stable and complete.
        let after: string | null = null;
        for (;;) {
            const rows: Array<{ id: string; h: string; e: string }> =
                await prisma.$queryRawUnsafe(
                    `SELECT "id", "${c.hashColumn}" AS h, "${c.encryptedColumn}" AS e
                       FROM "${c.table}"
                      WHERE "${c.hashColumn}" IS NOT NULL
                        AND "${c.encryptedColumn}" IS NOT NULL
                        ${after === null ? '' : 'AND "id" > $2'}
                      ORDER BY "id"
                      LIMIT $1`,
                    ...(after === null ? [batchSize] : [batchSize, after]),
                );
            if (rows.length === 0) break;

            for (const row of rows) {
                result.scanned++;
                after = row.id;

                let plaintext: string;
                try {
                    plaintext = decryptField(row.e);
                } catch (err) {
                    result.errors++;
                    logger.error('lookup-rehash.decrypt_failed', {
                        component: 'lookup-rehash',
                        model: c.model,
                        id: row.id,
                        error: err instanceof Error ? err.message : 'unknown',
                    });
                    continue;
                }

                const expected = hashForLookup(plaintext);
                if (row.h === expected) {
                    result.alreadyCurrent++;
                    continue;
                }

                try {
                    await prisma.$executeRawUnsafe(
                        `UPDATE "${c.table}" SET "${c.hashColumn}" = $1 WHERE "id" = $2`,
                        expected,
                        row.id,
                    );
                    result.rehashed++;
                } catch (err) {
                    result.errors++;
                    // A unique violation here means TWO rows claim one address
                    // — the duplicate-User defect #1237 exists to prevent. The
                    // id is the only useful thing to hand an operator; a
                    // swallow would leave a sweep reporting done over a
                    // database that is not.
                    const isUnique =
                        err instanceof Prisma.PrismaClientKnownRequestError &&
                        err.code === 'P2002';
                    if (isUnique || String(err).includes('23505')) {
                        result.collisions.push(row.id);
                    }
                    logger.error('lookup-rehash.update_failed', {
                        component: 'lookup-rehash',
                        model: c.model,
                        id: row.id,
                        collision: isUnique,
                        error: err instanceof Error ? err.message : 'unknown',
                    });
                }
            }

            if (rows.length < batchSize) break;
        }

        out.push(result);
    }

    return out;
}

/**
 * May `LOOKUP_HMAC_KEY_PREVIOUS` be removed?
 *
 * True only when NOTHING is stale and nothing is undecryptable. The second
 * term matters: a row nobody can decrypt cannot be proved current, and
 * answering "yes, retire the key" over it would make that row permanently
 * unreadable by every lookup path.
 */
export async function lookupPreviousKeyRetirable(
    /**
     * Pre-computed counts, to avoid a second full scan.
     *
     * Every row in scope is DECRYPTED to answer this, so the cost is real
     * rather than a round trip: the console's GET wants both the breakdown and
     * the verdict, and computing them independently decrypted the whole table
     * twice. Omitting the argument still does its own scan, which is what a
     * caller wanting a FRESH reading after a write pass needs.
     */
    counts?: Awaited<ReturnType<typeof countStaleLookupHashes>>,
): Promise<{ retirable: boolean; stale: number; undecryptable: number }> {
    const c = counts ?? (await countStaleLookupHashes());
    const undecryptable = c.perColumn.reduce((a, col) => a + col.undecryptable, 0);
    return {
        // Both terms, and `&&` not `||`: see the docblock. A row that cannot be
        // decrypted cannot be proved current.
        retirable: c.stale === 0 && undecryptable === 0,
        stale: c.stale,
        undecryptable,
    };
}
