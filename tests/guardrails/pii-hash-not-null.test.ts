/**
 * GAP-21 — Structural ratchet for the schema/DB drift on emailHash.
 *
 * The Prisma schema declares `User.emailHash`,
 * `AuditorAccount.emailHash`, and `UserIdentityLink.emailAtLinkTimeHash`
 * as NULLABLE (`String?`). This is a deliberate, narrow lie at the
 * TS level so callers don't have to thread `emailHash:
 * hashForLookup(email)` through every `prisma.user.create({...})`
 * site — the pii-middleware populates it from the `email` field on
 * every write.
 *
 * The TRUTH is enforced at the database level: migration
 * 20260429000000_gap21_drop_pii_plaintext_columns sets each of these
 * columns to NOT NULL, so any write that bypasses the middleware
 * (raw SQL, a misconfigured client) is rejected at the DB.
 *
 * This guardrail keeps the two states in sync. It fails CI if:
 *
 *   1. The schema drops the `?` (declares the field NOT NULL) without
 *      removing this nullability ratchet — meaning every call site
 *      now MUST be updated to provide emailHash.
 *
 *   2. Any subsequent migration drops NOT NULL on these columns —
 *      reopening the loophole that lets a row land without a hash
 *      and silently breaks uniqueness lookups.
 *
 * Why a guardrail rather than just keeping schema and DB in lockstep:
 * the cost of touching every test/seed call site for a synthetic
 * type-level requirement that the middleware already enforces is
 * higher than the cost of one structural test.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const SCHEMA_DIR = join(REPO_ROOT, 'prisma', 'schema');
const MIGRATIONS_DIR = join(REPO_ROOT, 'prisma', 'migrations');

const HASH_FIELDS_EXPECTED_NULLABLE: Array<{
    file: string;
    model: string;
    field: string;
}> = [
    { file: 'auth.prisma', model: 'User', field: 'emailHash' },
    { file: 'auth.prisma', model: 'UserIdentityLink', field: 'emailAtLinkTimeHash' },
];

/**
 * The DB columns the GAP-21 migration set NOT NULL. The corresponding
 * schema field is declared nullable for the TS-side ergonomics
 * described above; this list is the safety net that fails CI if
 * anyone writes a migration that drops NOT NULL.
 *
 * `AuditorAccount` is still listed even though GRC teardown phase 3
 * DROPPED that table, and deliberately so: the two assertions below
 * read MIGRATION TEXT, not the live schema. The GAP-21 migration is
 * applied history and its `ALTER COLUMN … SET NOT NULL` lines are
 * still in it; removing the entry would stop asserting something that
 * remains true. The live-schema half of this ratchet is
 * `HASH_FIELDS_EXPECTED_NULLABLE` above, which no longer names it.
 */
const NOT_NULL_DB_COLUMNS = [
    { table: 'User', column: 'emailHash' },
    { table: 'User', column: 'emailEncrypted' },
    { table: 'AuditorAccount', column: 'emailHash' },
    { table: 'AuditorAccount', column: 'emailEncrypted' },
    { table: 'UserIdentityLink', column: 'emailAtLinkTimeHash' },
    { table: 'UserIdentityLink', column: 'emailAtLinkTimeEncrypted' },
];

describe('GAP-21 — schema/DB nullability ratchet', () => {
    test('Prisma schema declares hash fields as nullable (TS ergonomics)', () => {
        for (const { file, model, field } of HASH_FIELDS_EXPECTED_NULLABLE) {
            const text = readFileSync(join(SCHEMA_DIR, file), 'utf8');
            // Locate the model block.
            const modelMatch = text.match(
                new RegExp(`^model ${model}\\s*\\{([\\s\\S]*?)^\\}`, 'm'),
            );
            expect(modelMatch).not.toBeNull();
            const block = modelMatch![1];
            // Field declaration should end with `?` (nullable).
            const fieldRe = new RegExp(`^\\s*${field}\\s+String\\?`, 'm');
            expect(fieldRe.test(block)).toBe(true);
        }
    });

    test('Initial GAP-21 migration sets each hash column NOT NULL at the DB', () => {
        const migrationFile = join(
            MIGRATIONS_DIR,
            '20260429000000_gap21_drop_pii_plaintext_columns',
            'migration.sql',
        );
        const sql = readFileSync(migrationFile, 'utf8');
        for (const { table, column } of NOT_NULL_DB_COLUMNS) {
            const re = new RegExp(
                `ALTER TABLE\\s+"${table}"\\s+ALTER COLUMN\\s+"${column}"\\s+SET NOT NULL`,
                'i',
            );
            expect(sql).toMatch(re);
        }
    });

    test('No subsequent migration drops NOT NULL on the protected columns', () => {
        // Walk every migration directory; each migration is an
        // ordered file. Anything that lands AFTER GAP-21 with
        // `DROP NOT NULL` on one of the protected columns is a
        // regression — block the whole suite.
        const dirs = readdirSync(MIGRATIONS_DIR)
            .filter((d) => statSync(join(MIGRATIONS_DIR, d)).isDirectory())
            .sort();
        const gap21Idx = dirs.findIndex((d) =>
            d.includes('gap21_drop_pii_plaintext_columns'),
        );
        expect(gap21Idx).toBeGreaterThanOrEqual(0);

        const offenders: string[] = [];
        for (let i = gap21Idx + 1; i < dirs.length; i++) {
            const sqlPath = join(MIGRATIONS_DIR, dirs[i], 'migration.sql');
            try {
                const sql = readFileSync(sqlPath, 'utf8');
                for (const { table, column } of NOT_NULL_DB_COLUMNS) {
                    const re = new RegExp(
                        `ALTER TABLE\\s+"${table}"\\s+ALTER COLUMN\\s+"${column}"\\s+DROP NOT NULL`,
                        'i',
                    );
                    if (re.test(sql)) {
                        offenders.push(`${dirs[i]}: drops NOT NULL on ${table}.${column}`);
                    }
                }
            } catch {
                // Migration directory without a migration.sql — skip.
            }
        }
        expect(offenders).toEqual([]);
    });
});

describe('GAP-21 — runtime callers MUST not query plaintext columns on managed models', () => {
    /**
     * Walks the production source tree and refuses to find any
     * `where: { email:` clause whose model is User / AuditorAccount /
     * UserIdentityLink. The middleware would silently rewrite such a
     * query to the hash variant at runtime — but having the rewrite
     * present at the call site is a smell: it tells us the developer
     * doesn't know the data is encrypted, and they may make
     * decisions (logging, joining, projecting) that leak plaintext.
     *
     * Carve-outs are explicit and per-line: anything in
     * `EXEMPTED_PATHS` (test fixtures, the migration backfill script,
     * email-verification's identifier-shaped lookup) is allowed.
     * Adding to that list requires a one-line reason.
     */
    const ROOT = REPO_ROOT;
    const SRC = join(ROOT, 'src');

    // Files that are explicitly allowed to query `where: { email: ... }`
    // because the lookup is structural, not semantic. Each entry has
    // a written reason.
    const EXEMPTED_PATHS: ReadonlyArray<{ path: string; reason: string }> = [
        // No exemptions today — every call site has been migrated.
        // Add here only with a written reason.
    ];

    function* walk(dir: string): Generator<string> {
        for (const entry of readdirSync(dir)) {
            if (entry === 'node_modules' || entry.startsWith('.')) continue;
            const full = join(dir, entry);
            const st = statSync(full);
            if (st.isDirectory()) yield* walk(full);
            else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) yield full;
        }
    }

    test('no production code path queries plaintext email on User/AuditorAccount', () => {
        const offenders: string[] = [];
        const FORBIDDEN = /where:\s*\{\s*[^}]*\bemail:\s*['"]/;
        for (const file of walk(SRC)) {
            const rel = file.replace(ROOT + '/', '');
            if (EXEMPTED_PATHS.some((e) => rel === e.path)) continue;
            if (rel.endsWith('.test.ts')) continue;
            const text = readFileSync(file, 'utf8');
            // Quick reject — most files don't mention `email:` at all.
            if (!text.includes('email')) continue;
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (!FORBIDDEN.test(line)) continue;
                // Confirm the file is talking to a PII-managed model.
                // We don't try to parse the AST; instead we check
                // whether the same file references prisma.user,
                // prisma.auditorAccount, or prisma.userIdentityLink.
                // False positives are fine — they signal a write that
                // probably also needs migrating.
                if (
                    /\bprisma\.user\b|\bprisma\.auditorAccount\b|\bprisma\.userIdentityLink\b|\.user\.|\.auditorAccount\.|\.userIdentityLink\./.test(text)
                ) {
                    offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
                }
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                `Found ${offenders.length} plaintext-email WHERE clause(s) on PII-managed models. ` +
                    `Switch to where: { emailHash: hashForLookup(email) } or add the file to ` +
                    `EXEMPTED_PATHS in this guardrail with a written reason.\n\n` +
                    offenders.map((o) => `  ${o}`).join('\n'),
            );
        }
    });
});
