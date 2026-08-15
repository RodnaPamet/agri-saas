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
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
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

    it('Helm chart migration command targets the folder, not the monolith', () => {
        const valuesPath = path.join(REPO_ROOT, 'infra/helm/inflect/values.yaml');
        if (!fs.existsSync(valuesPath)) return; // chart optional in some checkouts
        const src = fs.readFileSync(valuesPath, 'utf-8');
        expect(src).toMatch(/--schema=\.\/prisma\/schema(\b|\s|$)/);
        expect(src).not.toMatch(/--schema=\.\/prisma\/schema\.prisma/);
    });

    it('entrypoint.sh migration command targets the folder', () => {
        const entrypointPath = path.join(REPO_ROOT, 'scripts/entrypoint.sh');
        if (!fs.existsSync(entrypointPath)) return;
        const src = fs.readFileSync(entrypointPath, 'utf-8');
        expect(src).toMatch(/--schema=\.\/prisma\/schema(\b|\s|$)/);
        expect(src).not.toMatch(/--schema=\.\/prisma\/schema\.prisma/);
    });

    it('no test reads the legacy monolith path as a real file (only doc comments are allowed)', () => {
        // Ratchet against silent drift: a future test that does
        // `fs.readFileSync('prisma/schema.prisma', ...)` would still
        // fail at runtime (the file doesn't exist) but the failure
        // mode is opaque. This guard catches the regression at the
        // code level so the message points at the fix:
        // "use readPrismaSchema() from tests/helpers/prisma-schema".
        const violations: string[] = [];
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === 'node_modules' || entry.name === '.next') continue;
                    walk(full);
                    continue;
                }
                if (!/\.(ts|tsx)$/.test(entry.name)) continue;
                // The helper itself owns the path constant; this
                // ratchet's own file references the legacy path in
                // explanatory comments only.
                const rel = path.relative(REPO_ROOT, full);
                if (rel === 'tests/helpers/prisma-schema.ts') continue;
                if (rel === 'tests/guardrails/prisma-schema-folder-coverage.test.ts') continue;

                const src = fs.readFileSync(full, 'utf-8');
                // Match only real read calls — readFileSync, statSync,
                // existsSync — applied to a path that ends in
                // `prisma/schema.prisma`. Comments and JSDoc references
                // pass through.
                const re = /(?:readFileSync|existsSync|statSync)\([^)]*['"][^'"]*prisma\/schema\.prisma['"][^)]*\)/g;
                if (re.test(src)) {
                    violations.push(rel);
                }
            }
        };
        walk(REPO_ROOT);

        if (violations.length > 0) {
            throw new Error(
                `${violations.length} file(s) read the legacy prisma/schema.prisma path directly:\n` +
                violations.map((v) => `  - ${v}`).join('\n') +
                '\n\nUse `readPrismaSchema()` from `tests/helpers/prisma-schema.ts` instead. ' +
                'GAP-09 split the monolith into prisma/schema/ — Prisma reads the whole folder.',
            );
        }
    });
});
