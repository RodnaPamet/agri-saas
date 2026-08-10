/**
 * The Control→Practice rollback script must stay a faithful inverse.
 *
 * `deploy/rollback/20260809120000_rename_control_to_practice.down.sql`
 * exists because an image-only rollback cannot undo a migration: pin
 * Watchtower to the previous tag and the old code queries `Control`,
 * `controlId`, `ControlStatus` — none of which exist after the rename.
 * Without the script the only other option is a snapshot restore, which
 * costs up to 24 hours of farm data (docs/backup-restore.md).
 *
 * A rollback script is the definition of code that is never exercised
 * until the worst possible moment. This guard is the cheap standing
 * check: every rename in the forward migration must have a matching
 * reverse statement in the down script, and vice versa. If someone edits
 * the forward migration — adds a column rename, drops one — the two
 * files fall out of bijection and this fails.
 *
 * WHY A STRUCTURAL GUARD AND NOT AN INTEGRATION TEST. Running the real
 * thing needs a database, and the DB-gated `describeFn = DB_AVAILABLE ?
 * describe : describe.skip` idiom would make this suite *greener by
 * running less* — the exact failure CLAUDE.md names under "Green is not
 * the same as executed". The behaviour was verified once, by hand,
 * against a real Postgres 16 carrying seeded rows: full history applied,
 * down script run (tables back to `Control*`, row values intact, RLS
 * enabled+forced with all three policies still attached, permissionsJson
 * rekeyed with its intent preserved, `_prisma_migrations` row deleted),
 * then `migrate deploy` re-applied the rename and everything round-
 * tripped. Residual drift afterwards was 31 statements, none of them
 * naming Control or Practice — identical to the repo's pre-existing
 * baseline. What that manual run CANNOT do is stay true, and that is
 * what this guard is for.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const FORWARD = path.join(
    ROOT,
    'prisma/migrations/20260809120000_rename_control_to_practice/migration.sql',
);
const DOWN = path.join(
    ROOT,
    'deploy/rollback/20260809120000_rename_control_to_practice.down.sql',
);

/** Executable lines only — the headers name plenty of identifiers. */
function statements(file: string): string[] {
    return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('--'));
}

/** A rename, normalised to `kind:from->to` so the two files compare. */
type Rename = { kind: string; from: string; to: string };

function parseRenames(lines: string[]): Rename[] {
    const out: Rename[] = [];
    for (const l of lines) {
        let m: RegExpMatchArray | null;

        if ((m = l.match(/^ALTER TYPE\s+"([^"]+)"\s+RENAME TO\s+"([^"]+)"/)))
            out.push({ kind: 'type', from: m[1], to: m[2] });
        else if ((m = l.match(/^ALTER TABLE\s+"([^"]+)"\s+RENAME TO\s+"([^"]+)"/)))
            out.push({ kind: 'table', from: m[1], to: m[2] });
        else if ((m = l.match(/^ALTER INDEX\s+"([^"]+)"\s+RENAME TO\s+"([^"]+)"/)))
            out.push({ kind: 'index', from: m[1], to: m[2] });
        else if (
            (m = l.match(
                /^ALTER TYPE\s+"([^"]+)"\s+RENAME VALUE\s+'([^']+)'\s+TO\s+'([^']+)'/,
            ))
        )
            out.push({ kind: `value:${m[1]}`, from: m[2], to: m[3] });
        else if (
            (m = l.match(
                /^ALTER TABLE\s+"([^"]+)"\s+RENAME COLUMN\s+"([^"]+)"\s+TO\s+"([^"]+)"/,
            ))
        )
            // Keyed on the COLUMN pair only. The table is named differently on
            // each side (`Practice*` forward, `Practice*` in the down script
            // too — it renames columns before tables), but keying on the table
            // would still be brittle if the ordering ever changed.
            out.push({ kind: 'column', from: m[2], to: m[3] });
        else if (
            (m = l.match(
                /^ALTER TABLE\s+"([^"]+)"\s+RENAME CONSTRAINT\s+"([^"]+)"\s+TO\s+"([^"]+)"/,
            ))
        )
            out.push({ kind: 'constraint', from: m[2], to: m[3] });
    }
    return out;
}

const key = (r: Rename) => `${r.kind}:${r.from}->${r.to}`;
const flip = (r: Rename) => `${r.kind}:${r.to}->${r.from}`;

const FORWARD_LINES = statements(FORWARD);
const DOWN_LINES = statements(DOWN);
const fwd = parseRenames(FORWARD_LINES);
const down = parseRenames(DOWN_LINES);

describe('Control→Practice rollback script is a faithful inverse', () => {
    it('both files exist and parse to a real population', () => {
        expect(fwd.length).toBeGreaterThan(100);
        expect(down.length).toBeGreaterThan(100);
    });

    it('every forward rename has a reverse in the down script', () => {
        const have = new Set(down.map(key));
        const missing = fwd.filter((r) => !have.has(flip(r)));
        if (missing.length > 0) {
            throw new Error(
                `${missing.length} forward rename(s) have no inverse in the ` +
                    `rollback script. A partial rollback leaves the database ` +
                    `in a shape NEITHER image can run. Add the reverse ` +
                    `statement(s):\n` +
                    missing.map((r) => `  ${r.kind}: ${r.to} -> ${r.from}`).join('\n'),
            );
        }
        expect(missing).toEqual([]);
    });

    it('the down script renames nothing the forward migration did not', () => {
        // Catches a reverse statement left behind after the forward
        // migration drops one — it would fail at runtime on an object
        // that no longer carries that name, aborting the whole rollback.
        const have = new Set(fwd.map(key));
        const extra = down.filter((r) => !have.has(flip(r)));
        if (extra.length > 0) {
            throw new Error(
                `${extra.length} statement(s) in the rollback script reverse ` +
                    `something the forward migration never renamed:\n` +
                    extra.map((r) => `  ${r.kind}: ${r.from} -> ${r.to}`).join('\n'),
            );
        }
        expect(extra).toEqual([]);
    });

    it('the permission-domain rekey is mirrored', () => {
        // The one DATA statement. Forward moves `controls` -> `practices`
        // in TenantCustomRole.permissionsJson; without the mirror, old
        // code reads a key that is not there and parsePermissionsJson
        // silently substitutes base-role defaults.
        const f = FORWARD_LINES.join('\n');
        const d = DOWN_LINES.join('\n');
        expect(f).toMatch(/"permissionsJson"\s*-\s*'controls'/);
        expect(f).toMatch(/jsonb_build_object\('practices'/);
        expect(d).toMatch(/"permissionsJson"\s*-\s*'practices'/);
        expect(d).toMatch(/jsonb_build_object\('controls'/);
        // Both guarded + idempotent.
        expect(d).toMatch(/jsonb_typeof\("permissionsJson"\)\s*=\s*'object'/);
        expect(d).toMatch(/"permissionsJson"\s*\?\s*'practices'/);
    });

    it('the down script deletes its _prisma_migrations row', () => {
        // Load-bearing, not housekeeping: `migrate deploy` consults that
        // table. Leave the row and a later roll-forward SKIPS the rename
        // as already-applied, putting new code on an old schema.
        const d = DOWN_LINES.join('\n');
        expect(d).toMatch(/DELETE FROM "_prisma_migrations"/);
        expect(d).toMatch(
            /migration_name"\s*=\s*'20260809120000_rename_control_to_practice'/,
        );
    });

    it('the down script is one transaction', () => {
        // Postgres DDL is transactional, so a failure part-way leaves the
        // database untouched. A rollback runs under time pressure and
        // must not half-apply.
        expect(DOWN_LINES[0]).toBe('BEGIN;');
        expect(DOWN_LINES[DOWN_LINES.length - 1]).toBe('COMMIT;');
    });

    it('the parser actually distinguishes directions (mutation proof)', () => {
        // A comparison that ignored direction would pass on a script that
        // renamed the wrong way, which is the one bug that matters here.
        const sample = parseRenames(['ALTER TABLE "Control" RENAME TO "Practice";']);
        expect(sample).toEqual([{ kind: 'table', from: 'Control', to: 'Practice' }]);
        expect(key(sample[0])).toBe('table:Control->Practice');
        expect(flip(sample[0])).toBe('table:Practice->Control');
        expect(key(sample[0])).not.toBe(flip(sample[0]));
    });
});
