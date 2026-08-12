/**
 * Every DESTRUCTIVE migration ships a rollback inverse.
 *
 * ── Why this exists ─────────────────────────────────────────────────
 *
 * `prisma migrate deploy` runs from `scripts/entrypoint.sh`, so shipping
 * an image is what applies a migration. Pinning Watchtower back therefore
 * reverts the CODE while leaving the SCHEMA migrated — and after a drop or
 * a rename the previous image is querying objects that no longer exist, so
 * an image-only rollback fails outright. The only remaining lever is a
 * snapshot restore, which costs up to 24 hours of farm data (see
 * `docs/backup-restore.md`) to undo what may be a UI regression.
 *
 * `deploy/rollback/README.md` states the rule. This enforces it.
 *
 * ── Why it derives rather than lists ────────────────────────────────
 *
 * `rename-rollback-inverse.test.ts` guards ONE migration by hardcoded
 * path — it proves that specific inverse is faithful, which is a different
 * and deeper claim than this file makes. But a hardcoded path cannot
 * notice the SECOND destructive migration, and that is exactly the one
 * nobody remembers. This scans every migration in the tree, so a new drop
 * is covered the moment it lands.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const MIGRATIONS = path.join(ROOT, 'prisma/migrations');
const ROLLBACK = path.join(ROOT, 'deploy/rollback');

/**
 * The statement kinds that break the previous image.
 *
 * `ADD COLUMN` is deliberately absent — additive migrations need no
 * inverse, because the older image simply does not select the new column.
 * `DROP ... IF EXISTS` still counts: the guard is about what the schema
 * loses, not how defensively the SQL is written.
 */
const DESTRUCTIVE = [
    /\bDROP\s+TABLE\b/i,
    /\bDROP\s+COLUMN\b/i,
    /\bRENAME\s+TO\b/i,
    /\bRENAME\s+COLUMN\b/i,
    /\bDROP\s+TYPE\b/i,
];


/**
 * Destructive migrations that predate this rule.
 *
 * A BASELINE, not a target. Every entry here shipped before
 * `deploy/rollback/` existed as a convention, and each is far enough back
 * that no image old enough to need its inverse is deployable any more —
 * writing fifteen retrospective inverses would be ceremony, not safety.
 *
 * The direction of travel is that this list never grows. A NEW destructive
 * migration must ship its inverse; adding a name here instead is a
 * decision someone has to make in a diff, in front of a reviewer.
 */
const PREDATES_RULE: ReadonlySet<string> = new Set([
    '20260308225600_add_framework_pack_support',
    '20260309115528_audit_workflow_extensions',
    '20260310191803_unified_task_model',
    '20260312202023_add_soft_delete_fields',
    '20260418170121_remove_deprecated_user_tenant_role',
    '20260424000000_rename_audit_webhook_to_stream',
    '20260429000000_gap21_drop_pii_plaintext_columns',
    '20260630000000_agricultural_assets',
    '20260718120000_drop_asset_tags',
    '20260719140000_drop_log_entry_retention_until',
    '20260720100000_promotion_company',
    '20260722030000_drop_meteobot_station_url',
    '20260722040000_weather_observation_drop_rawjson',
    '20260807120000_merge_equipment_into_asset',
    '20260808140000_remove_grc_risk_and_control_exoskeleton',
]);

/** Executable lines only — headers discuss drops constantly. */
function executableSql(file: string): string {
    return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('--'))
        .join('\n');
}

function migrationDirs(): string[] {
    if (!fs.existsSync(MIGRATIONS)) return [];
    return fs
        .readdirSync(MIGRATIONS)
        .filter((d) => fs.existsSync(path.join(MIGRATIONS, d, 'migration.sql')))
        .sort();
}

function destructiveMigrations(): Array<{ name: string; kinds: string[] }> {
    const out: Array<{ name: string; kinds: string[] }> = [];
    for (const name of migrationDirs()) {
        const sql = executableSql(path.join(MIGRATIONS, name, 'migration.sql'));
        const kinds = DESTRUCTIVE.filter((re) => re.test(sql)).map((re) => re.source);
        if (kinds.length > 0 && !PREDATES_RULE.has(name)) out.push({ name, kinds });
    }
    return out;
}

describe('the baseline has no stale entries', () => {
    it.each([...PREDATES_RULE])('%s still exists and still has no inverse', (name) => {
        // A grandfathered migration that later GAINED an inverse should
        // leave this list, and one that was deleted outright should too —
        // otherwise the baseline slowly becomes fiction.
        expect(fs.existsSync(path.join(MIGRATIONS, name, 'migration.sql'))).toBe(true);
        expect(fs.existsSync(path.join(ROLLBACK, `${name}.down.sql`))).toBe(false);
    });
});

describe('destructive migrations ship a rollback inverse', () => {
    const found = destructiveMigrations();

    it('finds migrations at all (guard is not vacuously passing)', () => {
        // A moved directory or a changed filename would make every
        // assertion below iterate an empty list and pass.
        expect(migrationDirs().length).toBeGreaterThan(10);
    });

    it.each(found.length > 0 ? found : [{ name: '(none)', kinds: [] }])(
        '$name has deploy/rollback/<name>.down.sql',
        ({ name, kinds }) => {
            if (name === '(none)') return;
            const inverse = path.join(ROLLBACK, `${name}.down.sql`);
            const exists = fs.existsSync(inverse);
            expect(
                `${name} [${kinds.join(', ')}] → inverse present: ${exists}`,
            ).toBe(`${name} [${kinds.join(', ')}] → inverse present: true`);
        },
    );

    it.each(found.filter((f) => fs.existsSync(path.join(ROLLBACK, `${f.name}.down.sql`))))(
        '$name inverse deletes its own _prisma_migrations row',
        ({ name }) => {
            // Without this a roll-forward finds the migration already
            // recorded, skips it, and silently leaves the schema in the
            // rolled-back shape — the failure mode a rollback is supposed
            // to prevent.
            const sql = executableSql(path.join(ROLLBACK, `${name}.down.sql`));
            expect(sql).toMatch(/DELETE FROM "_prisma_migrations"/i);
            expect(sql).toContain(name);
        },
    );

    it.each(found.filter((f) => fs.existsSync(path.join(ROLLBACK, `${f.name}.down.sql`))))(
        '$name inverse runs in ONE transaction',
        ({ name }) => {
            // A half-applied rollback is worse than none: the schema then
            // matches neither image.
            const sql = executableSql(path.join(ROLLBACK, `${name}.down.sql`));
            expect(sql).toMatch(/^BEGIN;/im);
            expect(sql).toMatch(/COMMIT;$/im);
        },
    );
});
