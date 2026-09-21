/**
 * GAP-09 — multi-file schema durability ratchet.
 *
 * Locks in the multi-file Prisma schema layout so the repo can't
 * silently drift back to a monolithic `prisma/schema.prisma`. Two
 * structural assertions:
 *
 *   1. The folder `prisma/schema/` exists and contains the seven
 *      domain files (base, auth, compliance, vendor, audit,
 *      automation, enums) plus the transitional `schema.prisma`
 *      sediment file. A future PR that deletes a domain file
 *      (collapsing the schema) trips this test.
 *
 *   2. The `prismaSchemaFolder` preview feature is enabled in
 *      `base.prisma`. Removing it would silently break Prisma's
 *      ability to read the folder layout on Prisma 5.x.
 *
 *   3. NO file in the repo (outside this guardrail and the helpers
 *      that explicitly own the path constant) reads
 *      `prisma/schema.prisma` as if it were the canonical schema.
 *      A test that grep-reads the schema must use `readPrismaSchema()`
 *      from `tests/helpers/prisma-schema.ts`.
 *
 *   4. The Helm chart's migration job points at the folder, not the
 *      old monolith path. Same story for any new tooling that
 *      passes `--schema=...` to the Prisma CLI.
 *
 * If a future contributor adds a new domain file (say
 * `notifications.prisma`) the folder check still passes — it
 * asserts the seven canonical files exist, not that the folder is
 * exactly seven files. New domains add coverage, they don't break
 * it.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * Directories whose .ts files are not this checkout's source.
 *
 * `.claude/worktrees/` holds FULL CHECKOUTS of other branches — agent
 * worktrees that git tracks but .gitignore excludes. A file found there is
 * a copy of some other branch's source, so reporting it against this branch
 * is a false positive twice over: the violation is not in this tree, and
 * the fix is not in this tree either. It also can't reach CI, which checks
 * out fresh. Scope only, never leniency: a real violation anywhere in the
 * working tree is still reported, which the SELF-TEST below proves.
 */
const NON_SOURCE_DIRS = new Set(['node_modules', '.next', '.claude']);

/**
 * Files that legitimately name the legacy path: the helper owns the path
 * constant, and this ratchet mentions it in prose and in its own fixtures.
 */
const PATH_OWNERS = new Set([
    'tests/helpers/prisma-schema.ts',
    'tests/guardrails/prisma-schema-folder-coverage.test.ts',
]);

/**
 * Every .ts/.tsx file under `root` that READS `prisma/schema.prisma` as a
 * real file. Matches only genuine read calls applied to a path ending in
 * `prisma/schema.prisma`; comments and JSDoc references pass through.
 * Returns paths relative to `root`.
 */
function collectLegacyPathReaders(root: string): string[] {
    const violations: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (NON_SOURCE_DIRS.has(entry.name)) continue;
                walk(full);
                continue;
            }
            if (!/\.(ts|tsx)$/.test(entry.name)) continue;
            const rel = path.relative(root, full);
            if (PATH_OWNERS.has(rel)) continue;
            const src = fs.readFileSync(full, 'utf-8');
            const re = /(?:readFileSync|existsSync|statSync)\([^)]*['"][^'"]*prisma\/schema\.prisma['"][^)]*\)/g;
            if (re.test(src)) violations.push(rel);
        }
    };
    walk(root);
    return violations;
}
const SCHEMA_DIR = path.resolve(REPO_ROOT, 'prisma/schema');

/**
 * The files GAP-09 requires to exist. `compliance.prisma` and
 * `vendor.prisma` were here until GRC teardown phase 3 deleted them
 * along with the inherited GRC schema; `processes.prisma` was emptied
 * in phase 1 and deleted in phase 3 (its models live in
 * `automation.prisma`).
 */
const REQUIRED_DOMAIN_FILES = [
    'base.prisma',
    'enums.prisma',
    'auth.prisma',
    'audit.prisma',
    'automation.prisma',
    'work.prisma',
    'files.prisma',
    'assets.prisma',
    'schema.prisma',
];

/**
 * Files that must NOT come back. Recreating one would re-establish the
 * GRC domain boundary the teardown removed, and a new agri model landing
 * in it would be invisible to everyone looking in the domain files.
 */
const DELETED_GRC_FILES = ['compliance.prisma', 'vendor.prisma', 'processes.prisma'];

describe('GAP-09 — multi-file Prisma schema layout', () => {
    it('prisma/schema/ folder exists', () => {
        expect(fs.existsSync(SCHEMA_DIR)).toBe(true);
        expect(fs.statSync(SCHEMA_DIR).isDirectory()).toBe(true);
    });

    it('the legacy monolithic prisma/schema.prisma does NOT exist', () => {
        // Prisma's auto-detection prefers the single-file form when
        // both layouts are present, which would silently revert the
        // split. The single file must stay deleted.
        const monolith = path.resolve(REPO_ROOT, 'prisma/schema.prisma');
        expect(fs.existsSync(monolith)).toBe(false);
    });

    for (const fname of REQUIRED_DOMAIN_FILES) {
        it(`prisma/schema/${fname} exists`, () => {
            const p = path.join(SCHEMA_DIR, fname);
            expect(fs.existsSync(p)).toBe(true);
        });
    }

    for (const fname of DELETED_GRC_FILES) {
        it(`prisma/schema/${fname} stays deleted`, () => {
            expect(fs.existsSync(path.join(SCHEMA_DIR, fname))).toBe(false);
        });
    }

    it('Prisma resolves the schema folder layout', () => {
        // Prisma 7 — multi-file schemas are GA, so the
        // `prismaSchemaFolder` preview flag was removed and the
        // location is now declared in `prisma.config.ts`. Pin the
        // config path so a future cleanup can't silently revert to
        // the monolith.
        const config = fs.readFileSync(
            path.resolve(REPO_ROOT, 'prisma.config.ts'),
            'utf-8',
        );
        // Pin the `schema:` field pointing at the folder. The exact
        // expression is `path.join('prisma', 'schema')` — match
        // either that literal or the constants.
        expect(config).toMatch(/schema:\s*path\.join\(/);
        expect(config).toContain("'schema'");
    });

    it('base.prisma owns the only generator + datasource blocks', () => {
        // Other files in prisma/schema/ MUST NOT redeclare these —
        // Prisma rejects duplicates across the folder.
        const otherFiles = REQUIRED_DOMAIN_FILES.filter((f) => f !== 'base.prisma');
        for (const f of otherFiles) {
            const src = fs.readFileSync(path.join(SCHEMA_DIR, f), 'utf-8');
            expect(src).not.toMatch(/^\s*generator\s+\w+\s*\{/m);
            expect(src).not.toMatch(/^\s*datasource\s+\w+\s*\{/m);
        }
    });

    it('entrypoint.sh migration command targets the folder', () => {
        const entrypointPath = path.join(REPO_ROOT, 'scripts/entrypoint.sh');
        if (!fs.existsSync(entrypointPath)) return;
        const src = fs.readFileSync(entrypointPath, 'utf-8');
        expect(src).toMatch(/--schema=\.\/prisma\/schema(\b|\s|$)/);
        expect(src).not.toMatch(/--schema=\.\/prisma\/schema\.prisma/);
    });

    it('no test reads the legacy monolith path as a real file (only doc comments are allowed)', () => {
        // Walks the repo; see collectLegacyPathReaders for the scope rules.
        // Ratchet against silent drift: a future test that does
        // `fs.readFileSync('prisma/schema.prisma', ...)` would still
        // fail at runtime (the file doesn't exist) but the failure
        // mode is opaque. This guard catches the regression at the
        // code level so the message points at the fix:
        // "use readPrismaSchema() from tests/helpers/prisma-schema".
        const violations = collectLegacyPathReaders(REPO_ROOT);

        if (violations.length > 0) {
            throw new Error(
                `${violations.length} file(s) read the legacy prisma/schema.prisma path directly:\n` +
                violations.map((v) => `  - ${v}`).join('\n') +
                '\n\nUse `readPrismaSchema()` from `tests/helpers/prisma-schema.ts` instead. ' +
                'GAP-09 split the monolith into prisma/schema/ — Prisma reads the whole folder.',
            );
        }
    });

    it('SELF-TEST: a real violation is caught; a .claude worktree copy of one is not', () => {
        // Narrowing a guard's population is a change to what it can see, so
        // it owes a POSITIVE CONTROL: the same offending line must still be
        // reported from a real path. Without this, `.claude` could be
        // widened later until the guard sees nothing and still reads green.
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gap09-guard-'));
        try {
            const offending = "const s = fs.readFileSync('prisma/schema.prisma', 'utf-8');";
            fs.writeFileSync(path.join(tmp, 'real.ts'), offending);
            const stale = path.join(tmp, '.claude', 'worktrees', 'wf-1');
            fs.mkdirSync(stale, { recursive: true });
            fs.writeFileSync(path.join(stale, 'copy.ts'), offending);

            const found = collectLegacyPathReaders(tmp);
            expect(found).toEqual(['real.ts']);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
