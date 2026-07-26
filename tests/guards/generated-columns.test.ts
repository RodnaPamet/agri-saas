/**
 * Database-generated columns — the application must never write them.
 *
 * `YieldRecord.netTonnesStd` is `GENERATED ALWAYS AS ... STORED`: Postgres
 * derives the moisture-adjusted tonnage from `grossTonnes` + `moisturePct`
 * on every insert and update of those inputs. That is the whole reason it
 * cannot drift — unlike a value application code maintains, which drifts the
 * moment one of the three write paths (the yield form, the journal-harvest
 * mint, a future import) forgets to recompute it.
 *
 * The catch is that Prisma does not model generated columns. The generated
 * client types `netTonnesStd` as an ordinary writable field, so nothing in
 * the type system stops someone from passing it in a `create`/`update` —
 * and Postgres answers that with `428C9: cannot insert a non-DEFAULT value
 * into column "netTonnesStd"`, i.e. a 500 on a write that looks perfectly
 * reasonable in the editor.
 *
 * This guard is that missing type check. It also pins the column's DDL, so
 * a future migration cannot quietly replace the generated column with a
 * plain one and leave every reader summing a column nobody updates.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

/** Columns Postgres owns. Extend with the migration that introduces one. */
const GENERATED_COLUMNS = [
    {
        model: 'YieldRecord',
        column: 'netTonnesStd',
        migration: 'prisma/migrations/20260726150000_yield_net_tonnes_standard_moisture/migration.sql',
    },
] as const;

function* walk(dir: string): Generator<string> {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.next') continue;
            yield* walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
            yield full;
        }
    }
}

describe('database-generated columns', () => {
    for (const { model, column, migration } of GENERATED_COLUMNS) {
        describe(`${model}.${column}`, () => {
            it('is declared GENERATED ... STORED in its migration', () => {
                const sql = fs.readFileSync(path.join(ROOT, migration), 'utf8');
                expect(sql).toMatch(new RegExp(`"${column}"[\\s\\S]*?GENERATED ALWAYS AS`));
                expect(sql).toMatch(/STORED/);
            });

            it('is documented in the Prisma schema as database-generated', () => {
                // Prisma types it as writable, so the comment is the only
                // in-editor signal a reader gets. If the field exists without
                // the warning, the next person has no way to know.
                const schema = fs.readFileSync(path.join(ROOT, 'prisma/schema/grain.prisma'), 'utf8');
                const idx = schema.indexOf(column);
                expect(idx).toBeGreaterThan(-1);
                const preceding = schema.slice(Math.max(0, idx - 1200), idx);
                expect(preceding).toMatch(/DATABASE-GENERATED/);
            });

            it('is never written by application code', () => {
                // Keyed on WRITE CALLS rather than on the value's shape: the
                // column legitimately appears as `netTonnesStd: true` in a
                // `_sum`, and as `netTonnesStd: null` in a WHERE predicate
                // (rows with no moisture reading). What must never happen is
                // the column appearing inside a create/update payload, which
                // Postgres answers with 428C9 rather than a validation error.
                const WRITE_CALLS = /\.(create|createMany|update|updateMany|upsert)\s*\(/g;
                const offenders: string[] = [];
                for (const file of walk(path.join(ROOT, 'src'))) {
                    const content = fs.readFileSync(file, 'utf8');
                    if (!content.includes(column)) continue;
                    for (const m of content.matchAll(WRITE_CALLS)) {
                        // The call's argument object, bounded generously —
                        // long enough to cover a realistic `data: { … }`,
                        // short enough not to swallow the next statement.
                        const slice = content.slice(m.index ?? 0, (m.index ?? 0) + 2000);
                        const dataIdx = slice.indexOf('data:');
                        if (dataIdx === -1) continue;
                        if (new RegExp(`(^|[^\\w.])${column}\\s*:`).test(slice.slice(dataIdx))) {
                            offenders.push(`${path.relative(ROOT, file)}: ${m[0]} writes ${column}`);
                        }
                    }
                }
                expect(offenders).toEqual([]);
            });
        });
    }
});
