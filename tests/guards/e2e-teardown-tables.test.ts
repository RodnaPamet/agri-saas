/**
 * E2E teardown table list — every name must be a real tenant-scoped model.
 *
 * `tests/e2e/global-teardown.ts` deletes a hand-maintained list of tables
 * before dropping each test Tenant. The delete loop wraps every statement
 * in its own SAVEPOINT so one failure can't poison the transaction — which
 * is correct, but it also means a STALE name fails silently forever.
 *
 * That is exactly what happened: eleven entries named tables that no longer
 * exist (the ten risk / control-exoskeleton tables, plus `IntegrationEvent`
 * which had gone earlier), and `PolicyAcknowledgement` was deleted by
 * `WHERE "tenantId" = $1` on a model that has no `tenantId` column at all.
 * None of it failed a build. It just cost a failed round trip per table per
 * tenant teardown and buried the CI Postgres log in
 * `relation "X" does not exist`.
 *
 * Two invariants, both derived from the LIVE schema so they can't drift:
 *   1. every listed name resolves to a real `model` in `prisma/schema/`;
 *   2. every listed model actually has a `tenantId` field, since the delete
 *      predicate is `WHERE "tenantId" = $1`.
 *
 * This is a source-text guard (see CLAUDE.md, "Green is not the same as
 * executed") — it proves the LIST is well-formed, not that teardown runs.
 * The behaviour is covered by the E2E suite actually tearing down.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const TEARDOWN = path.join(ROOT, 'tests/e2e/global-teardown.ts');
const SCHEMA_DIR = path.join(ROOT, 'prisma/schema');

/** `{ ModelName -> field names }` parsed from the multi-file schema. */
function parseModels(): Map<string, Set<string>> {
    const models = new Map<string, Set<string>>();
    for (const file of fs.readdirSync(SCHEMA_DIR)) {
        if (!file.endsWith('.prisma')) continue;
        const src = fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf-8');
        const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) {
            const fields = new Set<string>();
            for (const line of m[2].split('\n')) {
                const f = line.trim().match(/^(\w+)\s+\S/);
                if (f) fields.add(f[1]);
            }
            models.set(m[1], fields);
        }
    }
    return models;
}

/** The string literals inside the `TENANT_CHILD_TABLES` array. */
function parseTeardownTables(): string[] {
    const src = fs.readFileSync(TEARDOWN, 'utf-8');
    const start = src.indexOf('const TENANT_CHILD_TABLES');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('];', start);
    expect(end).toBeGreaterThan(start);
    return [...src.slice(start, end).matchAll(/'([A-Za-z]\w+)'/g)].map(
        (m) => m[1],
    );
}

describe('E2E teardown table list', () => {
    const models = parseModels();
    const tables = parseTeardownTables();

    it('parses a non-empty list (the parser itself still works)', () => {
        expect(tables.length).toBeGreaterThan(20);
        expect(models.size).toBeGreaterThan(50);
    });

    it('every table names a real Prisma model', () => {
        const unknown = tables.filter((t) => !models.has(t));
        if (unknown.length > 0) {
            throw new Error(
                `tests/e2e/global-teardown.ts deletes from ${unknown.length} ` +
                    `table(s) that no longer exist in prisma/schema/. The ` +
                    `SAVEPOINT wrapper hides the error, so this costs a failed ` +
                    `round trip on every tenant teardown and never goes red on ` +
                    `its own. Remove them from TENANT_CHILD_TABLES:\n` +
                    unknown.map((t) => `  ${t}`).join('\n'),
            );
        }
        expect(unknown).toEqual([]);
    });

    it('every table has a tenantId field (the delete predicate)', () => {
        const noTenant = tables.filter(
            (t) => models.has(t) && !models.get(t)!.has('tenantId'),
        );
        if (noTenant.length > 0) {
            throw new Error(
                `These tables are deleted with \`WHERE "tenantId" = $1\` but ` +
                    `have no tenantId column, so the statement can never match ` +
                    `a row. Either drop them from TENANT_CHILD_TABLES (they are ` +
                    `covered by the documented orphan carve-out) or delete them ` +
                    `through their owning relation:\n` +
                    noTenant.map((t) => `  ${t}`).join('\n'),
            );
        }
        expect(noTenant).toEqual([]);
    });

    it('has no duplicate entries', () => {
        const seen = new Set<string>();
        const dupes = tables.filter((t) => (seen.has(t) ? true : (seen.add(t), false)));
        expect(dupes).toEqual([]);
    });
});
