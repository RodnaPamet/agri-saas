/**
 * Epic B.1 + GAP-21 — One-shot encryption / PII backfill.
 *
 * Two modes drive a single CLI; both are idempotent and rerunnable.
 *
 * ## Mode 1 — Epic B.1 in-place encryption (`ENCRYPTED_FIELDS`)
 *
 * Walks every (model, field) pair in `ENCRYPTED_FIELDS` and encrypts
 * rows that are still plaintext IN-PLACE — the column already holds
 * a sensitive value, the goal is to wrap it as `v1:`/`v2:` ciphertext
 * so reads decrypt transparently via the Prisma middleware.
 *
 * ## Mode 2 — GAP-21 PII backfill (`PII_BACKFILL_MANIFEST`)
 *
 * For models with PARALLEL columns — a legacy plaintext column
 * (e.g. `User.email`) plus dedicated `*Encrypted` and optional
 * `*Hash` lookup columns — copy the plaintext into the encrypted
 * column under the current KEK and populate the lookup hash.
 * The plaintext column stays untouched: a follow-up migration
 * drops it once every row is confirmed backfilled.
 *
 * The two manifests are intentionally separate. In-place encryption
 * mutates the source column; parallel-column backfill writes new
 * sibling columns and leaves the source alone for a later schema
 * migration. Conflating them would force every call site to know
 * which mode applies.
 *
 * ## Execution model
 *   - Reads via `$queryRawUnsafe`.
 *   - Writes via `$executeRawUnsafe`.
 *
 * Both raw paths bypass every Prisma `$use` middleware — in
 * particular the Epic B.1 encryption middleware itself, which would
 * otherwise double-encrypt (we'd read ciphertext, the middleware
 * would decrypt to plaintext, we'd re-encrypt with a new IV). The
 * raw path sees the true on-disk value and lets `isEncryptedValue`
 * decide whether work is needed.
 *
 * ## Idempotency
 * Mode 1: the SELECT filters out values that already start with the
 * `v1:` prefix, so a resumed run after a partial crash picks up
 * exactly where the last batch ended. A belt-and-braces per-row
 * `isEncryptedValue()` check inside the loop catches anything that
 * slipped through the SELECT (e.g. a writer landed a ciphertext
 * mid-run).
 *
 * Mode 2: the SELECT filters `WHERE plaintext IS NOT NULL AND
 * encrypted IS NULL`. Once a row's encrypted column is populated, it
 * never appears in a future batch. Empty-string plaintext is also
 * filtered (treated identically to NULL — nothing useful to back
 * up).
 *
 * ## Order of deployment
 *   1. Ship the encryption middleware (so new writes encrypt).
 *   2. Run this backfill with `--dry-run` to preview counts.
 *   3. Run with `--execute` to actually encrypt existing rows.
 *   4. Ship the coverage guardrail test that asserts 100% of
 *      manifest rows are ciphertext. If it's green, Epic B.1's
 *      read-path decrypt is safely covering the whole table.
 *
 * Running this BEFORE step 1 is also safe — the middleware is a pure
 * add-on that tolerates mixed state — but new rows written between
 * steps 2 and 3 will arrive as plaintext and need a follow-up batch.
 *
 * ## Safety invariants
 *   - Script reads rows that are plaintext OR that look plaintext
 *     after trimming. Never double-encrypts.
 *   - `--dry-run` is the DEFAULT. Writes require an explicit
 *     `--execute` flag.
 *   - Per-row errors are isolated — a single corrupted row does not
 *     abort the whole migration.
 *   - Never logs field values. Logs record counts, model, field,
 *     row ids, and error messages.
 *
 * ## Usage
 *   npx tsx scripts/encrypt-existing-data.ts                     # dry-run (BOTH modes)
 *   npx tsx scripts/encrypt-existing-data.ts --execute            # write (BOTH modes)
 *   npx tsx scripts/encrypt-existing-data.ts --execute --verify   # write + roundtrip verify
 *   npx tsx scripts/encrypt-existing-data.ts --models Risk,Finding   # mode-1 subset
 *   npx tsx scripts/encrypt-existing-data.ts --pii-only           # only mode 2 (GAP-21)
 *   npx tsx scripts/encrypt-existing-data.ts --skip-pii           # only mode 1 (Epic B.1)
 *   npx tsx scripts/encrypt-existing-data.ts --batch-size 100     # tune batch size
 */

// Require is used (not import) so the script runs under plain tsx
// without ESM/CommonJS friction.

const {
    encryptField,
    decryptField,
    isEncryptedValue,
    hashForLookup,
} = require('../src/lib/security/encryption') as typeof import('../src/lib/security/encryption');
const {
    ENCRYPTED_FIELDS,
} = require('../src/lib/security/encrypted-fields') as typeof import('../src/lib/security/encrypted-fields');


import { PrismaClient } from '@prisma/client';

// ─── Types ──────────────────────────────────────────────────────────

export interface BackfillOptions {
    /** When false (default), no writes are performed; only counts are reported. */
    execute: boolean;
    /**
     * Roundtrip-verify each written ciphertext by decrypting it and
     * comparing to the original plaintext. Adds an AES-GCM decrypt
     * per row; negligible cost, catches key/algorithm misconfigs.
     */
    verify: boolean;
    /** Batch size per SELECT / per model. Defaults to 500. */
    batchSize: number;
    /** Optional subset of model names to migrate. Empty = all. */
    modelsFilter: readonly string[];
    /** When true, skip Mode 1 (in-place ENCRYPTED_FIELDS) and run only PII backfill. */
    piiOnly: boolean;
    /** When true, skip Mode 2 (PII parallel-column backfill). */
    skipPii: boolean;
}

export interface FieldResult {
    model: string;
    field: string;
    scanned: number;                 // total rows read (plaintext candidates)
    encrypted: number;               // rows successfully encrypted + written
    skippedAlreadyEncrypted: number; // belt-and-braces hits inside the loop
    verifyFailures: number;          // --verify roundtrip mismatches
    errors: number;                  // per-row failures (logged + skipped)
}

/**
 * One PII-backfill target — a (model, plaintextColumn,
 * encryptedColumn, hashColumn?) tuple. `hashColumn` is omitted when
 * the value is never used as an indexed lookup key (names, phone
 * numbers, OAuth tokens).
 */
export interface PiiBackfillTarget {
    model: string;
    plaintextColumn: string;
    encryptedColumn: string;
    /** Optional — only present when the plaintext is searched by lookup. */
    hashColumn?: string;
}

export interface PiiFieldResult {
    model: string;
    plaintextColumn: string;
    encryptedColumn: string;
    hashColumn: string | null;
    scanned: number;
    backfilled: number;
    skippedAlreadyBackfilled: number;
    verifyFailures: number;
    errors: number;
}

export interface BackfillReport {
    options: BackfillOptions;
    results: FieldResult[];
    piiResults: PiiFieldResult[];
    totalScanned: number;
    totalEncrypted: number;
    totalSkipped: number;
    totalVerifyFailures: number;
    totalErrors: number;
    /** Total rows backfilled across PII parallel columns (mode 2). */
    totalPiiBackfilled: number;
    /** Total rows in mode 2 already populated and skipped. */
    totalPiiSkipped: number;
    durationMs: number;
}

// ─── PII backfill manifest (GAP-21) ─────────────────────────────────
//
// Source-of-truth list for every (plaintext → encrypted [+ hash])
// triple in the schema. Keep in sync with `prisma/schema/*.prisma`.
//
// When adding a new triple:
//   1. Add a row here.
//   2. The script picks it up automatically — no other change needed.
//   3. Add a unit test asserting the new row is in the manifest so a
//      schema rename can't silently drop it.

export const PII_BACKFILL_MANIFEST: readonly PiiBackfillTarget[] = [
    // User — auth identity. emailHash backs the indexed login lookup.
    { model: 'User', plaintextColumn: 'email', encryptedColumn: 'emailEncrypted', hashColumn: 'emailHash' },
    { model: 'User', plaintextColumn: 'name', encryptedColumn: 'nameEncrypted' },

    // GRC teardown phase 2: AuditorAccount + VendorContact left this
    // manifest with the PII middleware registry. Their tables survive
    // until the phase-3 drop, but nothing reads or writes them, so a
    // backfill would encrypt columns on the way to being dropped.

    // NotificationOutbox — outbound email recipients.
    { model: 'NotificationOutbox', plaintextColumn: 'toEmail', encryptedColumn: 'toEmailEncrypted' },

    // UserIdentityLink — SSO link record. Hash supports the
    // "find linked user by email at link time" lookup.
    { model: 'UserIdentityLink', plaintextColumn: 'emailAtLinkTime', encryptedColumn: 'emailAtLinkTimeEncrypted', hashColumn: 'emailAtLinkTimeHash' },

    // Account — NextAuth-managed OAuth token storage. Snake_case
    // column names mirror the upstream NextAuth schema; quoted in raw
    // SQL so they survive identifier validation. No hash column —
    // tokens are never looked up by value.
    { model: 'Account', plaintextColumn: 'access_token', encryptedColumn: 'accessTokenEncrypted' },
    { model: 'Account', plaintextColumn: 'refresh_token', encryptedColumn: 'refreshTokenEncrypted' },
];

// ─── Identifier validation ──────────────────────────────────────────
//
// Table + column names come from our own manifest, not user input, so
// strictly speaking interpolation is safe. We still validate defensively
// so a typo in the manifest produces a loud error instead of invalid
// SQL + a Postgres parse failure.

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(name: string, kind: string): void {
    if (!IDENT_RE.test(name)) {
        throw new Error(`Invalid ${kind} identifier: ${JSON.stringify(name)}`);
    }
}

// ─── Per-field backfill ─────────────────────────────────────────────

/**
 * Minimal Prisma surface the script uses. Declared here (rather than
 * via `Pick<PrismaClient, ...>`) so tests can inject a plain-promise
 * stub without wrestling with `PrismaPromise`'s branded type.
 */
export interface BackfillPrisma {
    $queryRawUnsafe<T = unknown>(sql: string, ...params: unknown[]): Promise<T>;
    $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number>;
}

export interface BackfillDeps {
    prisma: BackfillPrisma;
    /** Log sink — in tests we inject a spy. */
    log: (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
}

export async function encryptFieldForModel(
    deps: BackfillDeps,
    model: string,
    field: string,
    opts: BackfillOptions,
): Promise<FieldResult> {
    assertIdentifier(model, 'model');
    assertIdentifier(field, 'field');

    const result: FieldResult = {
        model,
        field,
        scanned: 0,
        encrypted: 0,
        skippedAlreadyEncrypted: 0,
        verifyFailures: 0,
        errors: 0,
    };

    const batchSize = Math.max(1, opts.batchSize);

    // SELECT excludes:
    //   - NULL values (nothing to encrypt)
    //   - empty strings (middleware passes them through as well)
    //   - values that start with the 'v1:' encryption version prefix
    //
    // Ordering by id keeps batches stable across a crash-resume.
    const selectSql = `
        SELECT id, "${field}" AS value
        FROM "${model}"
        WHERE "${field}" IS NOT NULL
          AND "${field}" <> ''
          AND "${field}" NOT LIKE 'v1:%'
        ORDER BY id
        LIMIT $1
    `;

    // Loop until we exhaust plaintext rows. Because the UPDATE
    // rewrites each returned row to ciphertext, the next SELECT
    // naturally returns the NEXT batch of plaintext rows (the ones
    // we just wrote are filtered out by `NOT LIKE 'v1:%'`).
    while (true) {
        let rows: Array<{ id: string; value: string }>;
        try {
            rows = await deps.prisma.$queryRawUnsafe<
                Array<{ id: string; value: string }>
            >(selectSql, batchSize);
        } catch (err) {
            deps.log('error', 'backfill.select_failed', {
                model,
                field,
                error: err instanceof Error ? err.message : String(err),
            });
            result.errors++;
            return result;
        }

        if (rows.length === 0) break;
        result.scanned += rows.length;

        for (const row of rows) {
            // Belt-and-braces — the SELECT already filtered `v1:%` out
            // but a stray value beating the filter (e.g. a ciphertext
            // that somehow doesn't start with the prefix on exactly
            // this row) would still be caught here.
            if (isEncryptedValue(row.value)) {
                result.skippedAlreadyEncrypted++;
                continue;
            }

            let ciphertext: string;
            try {
                ciphertext = encryptField(row.value);
            } catch (err) {
                result.errors++;
                deps.log('error', 'backfill.encrypt_failed', {
                    model,
                    field,
                    id: row.id,
                    error: err instanceof Error ? err.message : String(err),
                });
                continue;
            }

            if (opts.verify) {
                try {
                    const roundtrip = decryptField(ciphertext);
                    if (roundtrip !== row.value) {
                        result.verifyFailures++;
                        deps.log('error', 'backfill.verify_mismatch', {
                            model,
                            field,
                            id: row.id,
                        });
                        continue;
                    }
                } catch (err) {
                    result.verifyFailures++;
                    deps.log('error', 'backfill.verify_failed', {
                        model,
                        field,
                        id: row.id,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    continue;
                }
            }

            if (!opts.execute) {
                // Dry-run — count the would-encrypt, don't write.
                result.encrypted++;
                continue;
            }

            try {
                await deps.prisma.$executeRawUnsafe(
                    `UPDATE "${model}" SET "${field}" = $1 WHERE id = $2`,
                    ciphertext,
                    row.id,
                );
                result.encrypted++;
            } catch (err) {
                result.errors++;
                deps.log('error', 'backfill.update_failed', {
                    model,
                    field,
                    id: row.id,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        // Progress breadcrumb — one line per batch so operators can
        // track forward motion on a big table without drowning the
        // log stream. Never includes values.
        deps.log('info', 'backfill.batch_complete', {
            model,
            field,
            batchSize: rows.length,
            scannedSoFar: result.scanned,
            encryptedSoFar: result.encrypted,
            skippedSoFar: result.skippedAlreadyEncrypted,
        });

        // Tail case — a short batch means we've caught up.
        if (rows.length < batchSize) break;
    }

    return result;
}

// ─── PII parallel-column backfill (GAP-21) ──────────────────────────

/**
 * Copies a plaintext column into a parallel `*Encrypted` column and
 * (when present) a parallel `*Hash` lookup column.
 *
 * The plaintext column is left untouched — a follow-up schema
 * migration drops the plaintext after operators confirm 100% of
 * rows are backfilled.
 *
 * Idempotency: rows where the encrypted column is already populated
 * are filtered out by the SELECT and skipped at the row level. A
 * rerun after a partial crash picks up exactly where it left off.
 *
 * Null/empty handling: rows with NULL plaintext or empty-string
 * plaintext are filtered at the SELECT — there's nothing to back
 * up. The plaintext column may be required-NOT-NULL at the schema
 * level (e.g. `User.email`, `AuditorAccount.email`) but the script
 * is defensive against future nullable additions.
 *
 * The encrypted column receives the original plaintext value
 * (not normalised) so a future drop-the-plaintext migration is
 * lossless. The hash column receives `hashForLookup(value)` which
 * lower-cases + trims for consistent indexed lookups.
 */
export async function backfillParallelColumn(
    deps: BackfillDeps,
    target: PiiBackfillTarget,
    opts: BackfillOptions,
): Promise<PiiFieldResult> {
    assertIdentifier(target.model, 'model');
    assertIdentifier(target.plaintextColumn, 'plaintextColumn');
    assertIdentifier(target.encryptedColumn, 'encryptedColumn');
    if (target.hashColumn) {
        assertIdentifier(target.hashColumn, 'hashColumn');
    }

    const result: PiiFieldResult = {
        model: target.model,
        plaintextColumn: target.plaintextColumn,
        encryptedColumn: target.encryptedColumn,
        hashColumn: target.hashColumn ?? null,
        scanned: 0,
        backfilled: 0,
        skippedAlreadyBackfilled: 0,
        verifyFailures: 0,
        errors: 0,
    };

    const batchSize = Math.max(1, opts.batchSize);

    // SELECT excludes:
    //   - rows where the plaintext is NULL (nothing to copy)
    //   - rows where the plaintext is an empty string (treated like NULL)
    //   - rows where the encrypted column is already populated
    //
    // Ordering by id keeps batches stable across a crash-resume.
    const selectSql = `
        SELECT id, "${target.plaintextColumn}" AS value
        FROM "${target.model}"
        WHERE "${target.plaintextColumn}" IS NOT NULL
          AND "${target.plaintextColumn}" <> ''
          AND "${target.encryptedColumn}" IS NULL
        ORDER BY id
        LIMIT $1
    `;

    while (true) {
        let rows: Array<{ id: string; value: string }>;
        try {
            rows = await deps.prisma.$queryRawUnsafe<
                Array<{ id: string; value: string }>
            >(selectSql, batchSize);
        } catch (err) {
            deps.log('error', 'pii_backfill.select_failed', {
                model: target.model,
                plaintextColumn: target.plaintextColumn,
                encryptedColumn: target.encryptedColumn,
                error: err instanceof Error ? err.message : String(err),
            });
            result.errors++;
            return result;
        }

        if (rows.length === 0) break;
        result.scanned += rows.length;

        for (const row of rows) {
            // Belt-and-braces — should never trip given the SELECT,
            // but a writer landing a value mid-run could feed us a
            // value that's already encrypted-shaped. Skip cleanly.
            if (isEncryptedValue(row.value)) {
                result.skippedAlreadyBackfilled++;
                continue;
            }

            let ciphertext: string;
            let hashValue: string | null = null;
            try {
                ciphertext = encryptField(row.value);
                if (target.hashColumn) {
                    hashValue = hashForLookup(row.value);
                }
            } catch (err) {
                result.errors++;
                deps.log('error', 'pii_backfill.encrypt_failed', {
                    model: target.model,
                    plaintextColumn: target.plaintextColumn,
                    id: row.id,
                    error: err instanceof Error ? err.message : String(err),
                });
                continue;
            }

            if (opts.verify) {
                try {
                    const roundtrip = decryptField(ciphertext);
                    if (roundtrip !== row.value) {
                        result.verifyFailures++;
                        deps.log('error', 'pii_backfill.verify_mismatch', {
                            model: target.model,
                            plaintextColumn: target.plaintextColumn,
                            id: row.id,
                        });
                        continue;
                    }
                } catch (err) {
                    result.verifyFailures++;
                    deps.log('error', 'pii_backfill.verify_failed', {
                        model: target.model,
                        plaintextColumn: target.plaintextColumn,
                        id: row.id,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    continue;
                }
            }

            if (!opts.execute) {
                result.backfilled++;
                continue;
            }

            // Single atomic UPDATE — encrypted + (optional) hash land
            // together. A crash mid-UPDATE leaves the row entirely
            // un-backfilled, which the next run picks up cleanly.
            try {
                if (target.hashColumn) {
                    await deps.prisma.$executeRawUnsafe(
                        `UPDATE "${target.model}" ` +
                            `SET "${target.encryptedColumn}" = $1, "${target.hashColumn}" = $2 ` +
                            `WHERE id = $3`,
                        ciphertext,
                        hashValue,
                        row.id,
                    );
                } else {
                    await deps.prisma.$executeRawUnsafe(
                        `UPDATE "${target.model}" ` +
                            `SET "${target.encryptedColumn}" = $1 ` +
                            `WHERE id = $2`,
                        ciphertext,
                        row.id,
                    );
                }
                result.backfilled++;
            } catch (err) {
                result.errors++;
                deps.log('error', 'pii_backfill.update_failed', {
                    model: target.model,
                    plaintextColumn: target.plaintextColumn,
                    encryptedColumn: target.encryptedColumn,
                    hashColumn: target.hashColumn ?? null,
                    id: row.id,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        deps.log('info', 'pii_backfill.batch_complete', {
            model: target.model,
            plaintextColumn: target.plaintextColumn,
            encryptedColumn: target.encryptedColumn,
            hashColumn: target.hashColumn ?? null,
            batchSize: rows.length,
            scannedSoFar: result.scanned,
            backfilledSoFar: result.backfilled,
            skippedSoFar: result.skippedAlreadyBackfilled,
        });

        if (rows.length < batchSize) break;
    }

    return result;
}

// ─── Orchestration ──────────────────────────────────────────────────

export async function runBackfill(
    deps: BackfillDeps,
    options: BackfillOptions,
): Promise<BackfillReport> {
    const started = Date.now();
    const filter = new Set(options.modelsFilter);
    const results: FieldResult[] = [];
    const piiResults: PiiFieldResult[] = [];

    if (!options.piiOnly) {
        for (const [model, fields] of Object.entries(ENCRYPTED_FIELDS)) {
            if (filter.size > 0 && !filter.has(model)) continue;
            for (const field of fields) {
                const r = await encryptFieldForModel(deps, model, field, options);
                results.push(r);
            }
        }
    }

    if (!options.skipPii) {
        for (const target of PII_BACKFILL_MANIFEST) {
            if (filter.size > 0 && !filter.has(target.model)) continue;
            const r = await backfillParallelColumn(deps, target, options);
            piiResults.push(r);
        }
    }

    const totals = results.reduce(
        (acc, r) => ({
            totalScanned: acc.totalScanned + r.scanned,
            totalEncrypted: acc.totalEncrypted + r.encrypted,
            totalSkipped: acc.totalSkipped + r.skippedAlreadyEncrypted,
            totalVerifyFailures: acc.totalVerifyFailures + r.verifyFailures,
            totalErrors: acc.totalErrors + r.errors,
        }),
        {
            totalScanned: 0,
            totalEncrypted: 0,
            totalSkipped: 0,
            totalVerifyFailures: 0,
            totalErrors: 0,
        },
    );

    const piiTotals = piiResults.reduce(
        (acc, r) => ({
            totalScanned: acc.totalScanned + r.scanned,
            totalPiiBackfilled: acc.totalPiiBackfilled + r.backfilled,
            totalPiiSkipped: acc.totalPiiSkipped + r.skippedAlreadyBackfilled,
            totalVerifyFailures: acc.totalVerifyFailures + r.verifyFailures,
            totalErrors: acc.totalErrors + r.errors,
        }),
        {
            totalScanned: 0,
            totalPiiBackfilled: 0,
            totalPiiSkipped: 0,
            totalVerifyFailures: 0,
            totalErrors: 0,
        },
    );

    return {
        options,
        results,
        piiResults,
        totalScanned: totals.totalScanned + piiTotals.totalScanned,
        totalEncrypted: totals.totalEncrypted,
        totalSkipped: totals.totalSkipped,
        totalVerifyFailures: totals.totalVerifyFailures + piiTotals.totalVerifyFailures,
        totalErrors: totals.totalErrors + piiTotals.totalErrors,
        totalPiiBackfilled: piiTotals.totalPiiBackfilled,
        totalPiiSkipped: piiTotals.totalPiiSkipped,
        durationMs: Date.now() - started,
    };
}

// ─── CLI entry point ────────────────────────────────────────────────

export function parseArgs(argv: readonly string[]): BackfillOptions {
    const args = argv.slice(2);
    const execute = args.includes('--execute');
    const verify = args.includes('--verify');
    const piiOnly = args.includes('--pii-only');
    const skipPii = args.includes('--skip-pii');

    if (piiOnly && skipPii) {
        throw new Error('--pii-only and --skip-pii are mutually exclusive.');
    }

    let batchSize = 500;
    const batchArg = args.find((a) => a.startsWith('--batch-size='));
    if (batchArg) {
        const n = parseInt(batchArg.split('=')[1], 10);
        if (!Number.isFinite(n) || n < 1) {
            throw new Error(`Invalid --batch-size: ${batchArg}`);
        }
        batchSize = n;
    }

    let modelsFilter: string[] = [];
    const modelsArg = args.find((a) => a.startsWith('--models='));
    if (modelsArg) {
        modelsFilter = modelsArg
            .split('=')[1]
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        // Validate immediately so typos fail before touching the DB.
        // The model has to appear in EITHER manifest; an
        // ENCRYPTED_FIELDS-only filter is fine in --pii-only mode and
        // a PII-only filter is fine in --skip-pii mode, but a totally
        // unknown name is always a typo.
        const piiModels = new Set(PII_BACKFILL_MANIFEST.map((t) => t.model));
        for (const m of modelsFilter) {
            const inEncryptedFields = Object.prototype.hasOwnProperty.call(ENCRYPTED_FIELDS, m);
            const inPiiManifest = piiModels.has(m);
            if (!inEncryptedFields && !inPiiManifest) {
                throw new Error(`Unknown model in --models filter: ${m}`);
            }
        }
    }

    return { execute, verify, batchSize, modelsFilter, piiOnly, skipPii };
}

export function printReport(report: BackfillReport): void {
    const mode = report.options.execute ? 'EXECUTE' : 'DRY RUN';
    const line = (s: string): void => console.log(s);

    line('');
    line(`── Backfill — ${mode} ──`);
    line('');

    if (!report.options.execute) {
        line('⚠  No writes performed. Rerun with --execute to persist.');
        line('');
    }

    if (!report.options.piiOnly && report.results.length > 0) {
        line('Mode 1 — Epic B.1 in-place encryption:');
        for (const r of report.results) {
            const verb = report.options.execute ? 'encrypted' : 'would encrypt';
            line(
                `  ${r.model}.${r.field}: ${verb} ${r.encrypted}` +
                    `, skipped ${r.skippedAlreadyEncrypted}` +
                    `, errors ${r.errors}` +
                    (report.options.verify
                        ? `, verify-failures ${r.verifyFailures}`
                        : ''),
            );
        }
        line('');
    }

    if (!report.options.skipPii && report.piiResults.length > 0) {
        line('Mode 2 — GAP-21 PII parallel-column backfill:');
        for (const r of report.piiResults) {
            const verb = report.options.execute ? 'backfilled' : 'would backfill';
            const targetCols = r.hashColumn
                ? `${r.encryptedColumn} + ${r.hashColumn}`
                : r.encryptedColumn;
            line(
                `  ${r.model}.${r.plaintextColumn} → ${targetCols}: ${verb} ${r.backfilled}` +
                    `, skipped ${r.skippedAlreadyBackfilled}` +
                    `, errors ${r.errors}` +
                    (report.options.verify
                        ? `, verify-failures ${r.verifyFailures}`
                        : ''),
            );
        }
        line('');
    }

    line('── Totals ──');
    line(`  scanned:           ${report.totalScanned}`);
    if (!report.options.piiOnly) {
        line(
            `  ${report.options.execute ? 'encrypted' : 'would encrypt'}:         ${report.totalEncrypted}`,
        );
        line(`  already encrypted:  ${report.totalSkipped}`);
    }
    if (!report.options.skipPii) {
        line(
            `  ${report.options.execute ? 'pii backfilled' : 'pii would backfill'}: ${report.totalPiiBackfilled}`,
        );
        line(`  pii already done:   ${report.totalPiiSkipped}`);
    }
    if (report.options.verify) {
        line(`  verify failures:   ${report.totalVerifyFailures}`);
    }
    line(`  errors:            ${report.totalErrors}`);
    line(`  duration:          ${report.durationMs}ms`);
    line('');

    if (report.totalErrors > 0 || report.totalVerifyFailures > 0) {
        line('❌ Completed with errors — investigate log lines prefixed `backfill.` or `pii_backfill.` above.');
    } else if (!report.options.execute) {
        line('✅ Dry run complete. Rerun with --execute to perform the migration.');
    } else {
        line('✅ Backfill complete.');
    }
}

// ─── Main ───────────────────────────────────────────────────────────


async function main(): Promise<void> {
    const options = parseArgs(process.argv);
    const prisma = new PrismaClient();
    try {
        const log: BackfillDeps['log'] = (level, msg, fields) => {
            const payload = { component: 'backfill-epic-b', ...fields };
            if (level === 'error') console.error(msg, payload);
            else if (level === 'warn') console.warn(msg, payload);
            else console.log(msg, payload);
        };
        const report = await runBackfill({ prisma, log }, options);
        printReport(report);
        if (report.totalErrors > 0 || report.totalVerifyFailures > 0) {
            process.exit(1);
        }
    } finally {
        await prisma.$disconnect();
    }
}

// Only run main() when invoked directly (not when imported from tests).
if (require.main === module) {
    main().catch((err) => {
        console.error('backfill.fatal', err);
        process.exit(2);
    });
}

