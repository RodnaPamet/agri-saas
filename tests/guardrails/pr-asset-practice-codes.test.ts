/**
 * Asset code column + Asset/Practice code-generation ratchet.
 *
 *   1. Asset gains a `key` field (`AST-N`) minted atomically via
 *      `AssetKeySequence.upsert`. The Assets list page leads with
 *      the new Code column.
 *
 *   2. Practice gains a `PracticeKeySequence` counter, with the
 *      `createPractice` usecase minting `CTL-N` for the custom-
 *      practice create path (`isCustom && !code`). Framework-
 *      installed practices always supply their own `code` /
 *      `code` from the catalogue and bypass the counter.
 *
 *   3. The first-column registry flips Assets from `name` to
 *      `code` (Risk/Practices parity) and adds a written note.
 *
 * Mirrors `pr-b-tables-buttons.test.ts` for the Risk equivalent.
 * Adding a new key-minted entity ⇒ add a sibling ratchet here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * The WHOLE schema folder, concatenated.
 *
 * These assertions are about what the schema DECLARES, not about which file
 * happens to hold it -- and models do move between files: the GRC teardown
 * relocated the Task, Asset, Evidence and process-map families out of the
 * compliance-owned files in a single commit that changed no column at all.
 * Reading one file by name made this guard fail on that pure move, which is
 * a guard reporting on filing rather than on the property it exists to hold.
 */
const readSchema = (): string =>
    fs
        .readdirSync(path.join(ROOT, 'prisma/schema'))
        .filter((f) => f.endsWith('.prisma'))
        .map((f) => fs.readFileSync(path.join(ROOT, 'prisma/schema', f), 'utf8'))
        .join('\n');


describe('Asset Code column + Asset/Practice code generation', () => {
    describe('Asset key field + AssetKeySequence schema', () => {
        const schema = readSchema();

        it('Asset declares the key field + @@unique([tenantId, key])', () => {
            // Anchor on the Asset block bounded by its closing brace
            // followed by the next model declaration.
            const start = schema.indexOf('model Asset {');
            expect(start).toBeGreaterThan(0);
            const after = schema.slice(start);
            // First `}` followed by `\nmodel ` marks the end of the
            // Asset block in the schema. Take a generous slice to be
            // resilient to schema reflows.
            const block = after.slice(0, after.indexOf('\nmodel '));
            expect(block).toMatch(/^\s*key\s+String\?/m);
            expect(block).toMatch(/@@unique\(\[tenantId,\s*key\]\)/);
        });

        it('AssetKeySequence model exists with the canonical shape', () => {
            expect(schema).toMatch(/model AssetKeySequence/);
            // Same shape Risk/Task counters use: tenantId PK +
            // lastValue Int counter.
            const start = schema.indexOf('model AssetKeySequence');
            const block = schema.slice(start, start + 400);
            expect(block).toMatch(/tenantId\s+String\s+@id/);
            expect(block).toMatch(/lastValue\s+Int\s+@default\(0\)/);
        });
    });

    describe('Practice key sequence schema', () => {
        const schema = readSchema();

        it('PracticeKeySequence model exists', () => {
            expect(schema).toMatch(/model PracticeKeySequence/);
            const start = schema.indexOf('model PracticeKeySequence');
            const block = schema.slice(start, start + 400);
            expect(block).toMatch(/tenantId\s+String\s+@id/);
            expect(block).toMatch(/lastValue\s+Int\s+@default\(0\)/);
        });
    });

    describe('Migration adds Asset.key + both counter tables + Class A RLS', () => {
        const migration = read(
            'prisma/migrations/20260525080000_asset_and_control_keys/migration.sql',
        );

        it('adds Asset.key column + unique index', () => {
            expect(migration).toMatch(/ALTER TABLE "Asset" ADD COLUMN "key"/);
            expect(migration).toMatch(
                /CREATE UNIQUE INDEX "Asset_tenantId_key_key"/,
            );
        });

        it('creates AssetKeySequence with Class A RLS', () => {
            expect(migration).toMatch(/CREATE TABLE "AssetKeySequence"/);
            expect(migration).toMatch(
                /CREATE POLICY tenant_isolation ON "AssetKeySequence"/,
            );
            expect(migration).toMatch(
                /CREATE POLICY tenant_isolation_insert ON "AssetKeySequence"/,
            );
            expect(migration).toMatch(
                /CREATE POLICY superuser_bypass ON "AssetKeySequence"/,
            );
        });

        // The practice counter was created under its ORIGINAL name and
        // renamed in place later (see the rename assertions below).
        // Applied migrations are asserted verbatim — rewriting one changes
        // its checksum and breaks `migrate deploy` on every existing
        // database. The table's CURRENT name is asserted against the live
        // schema in the `Practice key sequence schema` block above.
        it('creates the practice counter with Class A RLS', () => {
            expect(migration).toMatch(/CREATE TABLE "ControlKeySequence"/);
            expect(migration).toMatch(
                /CREATE POLICY tenant_isolation ON "ControlKeySequence"/,
            );
            expect(migration).toMatch(
                /CREATE POLICY tenant_isolation_insert ON "ControlKeySequence"/,
            );
            expect(migration).toMatch(
                /CREATE POLICY superuser_bypass ON "ControlKeySequence"/,
            );
        });

        it('FORCE RLS on both counter tables', () => {
            expect(migration).toMatch(
                /ALTER TABLE "AssetKeySequence" FORCE ROW LEVEL SECURITY/,
            );
            expect(migration).toMatch(
                /ALTER TABLE "ControlKeySequence" FORCE ROW LEVEL SECURITY/,
            );
        });

        it('the rename migration carries the counter table to its new name', () => {
            const rename = read(
                'prisma/migrations/20260809120000_rename_control_to_practice/migration.sql',
            );
            expect(rename).toMatch(
                /ALTER TABLE "ControlKeySequence"\s+RENAME TO "PracticeKeySequence"/,
            );
        });

        it('Asset migration backfills the counter from existing AST-N keys', () => {
            expect(migration).toMatch(/INSERT INTO "AssetKeySequence"/);
            expect(migration).toMatch(/'\^AST-\(\[0-9\]\+\)\$'/);
        });
    });

    describe('AssetRepository.create mints from assetKeySequence.upsert', () => {
        const repo = read('src/app-layer/repositories/AssetRepository.ts');

        it('mints AST-N via the upsert counter', () => {
            expect(repo).toMatch(/assetKeySequence\.upsert/);
            expect(repo).toMatch(/`AST-\$\{seq\.lastValue\}`/);
        });

        it('mints only when no key is supplied', () => {
            expect(repo).toMatch(/if\s*\(!key\)\s*\{/);
        });
    });

    describe('createPractice usecase mints CTL-N for custom practices', () => {
        const usecase = read('src/app-layer/usecases/practice/mutations.ts');

        it('mints CTL-N via practiceKeySequence.upsert', () => {
            expect(usecase).toMatch(/practiceKeySequence\.upsert/);
            expect(usecase).toMatch(/`CTL-\$\{seq\.lastValue\}`/);
        });

        it('only mints when isCustom AND no explicit code supplied', () => {
            // The gate is `!code && isCustom` — both must hold for
            // the counter to advance. Framework-installed practices
            // (`isCustom: false`) never consume the sequence.
            expect(usecase).toMatch(/if\s*\(!code\s*&&\s*isCustom\)\s*\{/);
        });
    });

    describe('AssetsClient renders Code as the FIRST column', () => {
        const ui = read(
            'src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx',
        );

        it('column-visibility list leads with Code', () => {
            // `assetColumnList` declares `{ id: 'code', label: 'Code' }`
            // as its first entry — before the existing Name column.
            const start = ui.indexOf('const assetColumnList');
            expect(start).toBeGreaterThan(0);
            const slice = ui.slice(start, start + 1000);
            const firstIdMatch = slice.match(/id:\s*['"]([^'"]+)['"]/);
            expect(firstIdMatch).not.toBeNull();
            expect(firstIdMatch![1]).toBe('code');
        });

        it('column defs lead with the Code column before Name', () => {
            // Column DEFINITION order (not just the visibility list) —
            // the Code column declaration must appear before the
            // `accessorKey: 'name'` declaration in the same JSX block.
            const codeIdx = ui.indexOf("id: 'code'");
            const nameIdx = ui.indexOf("accessorKey: 'name'");
            expect(codeIdx).toBeGreaterThan(0);
            expect(nameIdx).toBeGreaterThan(codeIdx);
        });

        it('Code cell uses font-mono + tabular-nums + muted tone', () => {
            // First-column convention — the Code cell renders as a
            // quiet, aligned identifier so the eye scans the keys
            // column-wise without competing with the Name link.
            expect(ui).toMatch(
                /font-mono[^"]*text-xs[^"]*text-content-muted[^"]*tabular-nums/,
            );
        });
    });

    describe('first-column registry — Assets flipped to "code"', () => {
        const src = read('tests/guards/table-unification.test.ts');

        it('Assets entry declares firstColumnId="code"', () => {
            // Anchor on the REGISTRY, not on the first textual occurrence
            // of the path: GRC teardown phase 2 re-pointed the sibling
            // file's canonical-reference assertion at AssetsClient, so the
            // path now appears above the registry too and a naive
            // indexOf() slice lands in that assertion instead.
            const registryIdx = src.indexOf('const FIRST_COLUMN_TABLES');
            expect(registryIdx).toBeGreaterThan(-1);
            const entryIdx = src.indexOf(
                'assets/AssetsClient.tsx',
                registryIdx,
            );
            expect(entryIdx).toBeGreaterThan(-1);
            const entry = src.slice(entryIdx, entryIdx + 600);
            expect(entry).toMatch(/firstColumnId:\s*['"]code['"]/);
            expect(entry).toMatch(/adopted:\s*true/);
            // Note mentions AssetKeySequence so a "drop the note" PR
            // self-explains.
            expect(entry).toMatch(/AssetKeySequence/);
        });
    });
});
