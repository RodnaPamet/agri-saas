/**
 * Soft-Delete CI Guardrails
 *
 * Scan tests that fail if code patterns that bypass soft-delete semantics
 * are introduced. Prevents regressions.
 */
import * as fs from 'fs';
import * as path from 'path';
import { readPrismaSchema } from '../helpers/prisma-schema';

const SRC_DIR = path.join(__dirname, '..', '..', 'src');
const PRISMA_FILE = path.join(__dirname, '..', '..', 'src', 'lib', 'prisma.ts');
const SOFT_DELETE_FILE = path.join(__dirname, '..', '..', 'src', 'lib', 'soft-delete.ts');

const SOFT_DELETE_MODELS = [
    'Asset', 'Control', 'Evidence', 'Policy',
    'Vendor', 'FileRecord', 'Task', 'Finding',
    'Audit', 'AuditCycle', 'AuditPack',
];

/** Recursively collect .ts/.tsx files from a directory */
function collectFiles(dir: string, extensions = ['.ts', '.tsx']): string[] {
    const files: string[] = [];
    if (!fs.existsSync(dir)) return files;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            // Skip node_modules and .next
            if (entry.name === 'node_modules' || entry.name === '.next') continue;
            files.push(...collectFiles(fullPath, extensions));
        } else if (extensions.some(ext => entry.name.endsWith(ext))) {
            files.push(fullPath);
        }
    }
    return files;
}

describe('Soft-Delete CI Guardrails', () => {
    const allFiles = collectFiles(SRC_DIR);

    test('soft-delete extension is wired in prisma.ts', () => {
        const content = fs.readFileSync(PRISMA_FILE, 'utf-8');
        // Prisma 7 — v5 `registerSoftDeleteMiddleware($use)` was replaced
        // by `withSoftDeleteExtension($extends)`. Pin the new symbol.
        expect(content).toContain('withSoftDeleteExtension');
        expect(content).toContain("import { withSoftDeleteExtension } from './soft-delete'");
    });

    test('soft-delete.ts exports SOFT_DELETE_MODELS with the P0 models', () => {
        const content = fs.readFileSync(SOFT_DELETE_FILE, 'utf-8');
        for (const model of SOFT_DELETE_MODELS) {
            expect(content).toContain(`'${model}'`);
        }
    });

    test('no route handler calls db.X.delete directly for soft-delete models (should use usecases)', () => {
        const routeFiles = allFiles.filter(f => f.includes('route.ts') && f.includes(path.sep + 'api' + path.sep));
        const violations: string[] = [];

        for (const file of routeFiles) {
            const content = fs.readFileSync(file, 'utf-8');
            const relPath = path.relative(SRC_DIR, file);

            for (const model of SOFT_DELETE_MODELS) {
                const lower = model.charAt(0).toLowerCase() + model.slice(1);
                // Check for direct db.model.delete or prisma.model.delete patterns
                const patterns = [
                    `db.${lower}.delete`,
                    `prisma.${lower}.delete`,
                    `.${lower}.deleteMany`,
                ];
                for (const pattern of patterns) {
                    if (content.includes(pattern)) {
                        violations.push(`${relPath}: contains "${pattern}" — use usecase instead`);
                    }
                }
            }
        }

        expect(violations).toEqual([]);
    });

    /** Remove block and line comments so the scan reads code, not commentary. */
    function stripComments(src: string): string {
        return src
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/.*$/gm, '$1');
    }

    test('the comment stripper leaves code and removes commentary (self-check)', () => {
        expect(stripComments('/** DELETE FROM "Evidence" */\nconst a = 1;')).not.toContain('DELETE');
        expect(stripComments('// DELETE FROM "Evidence"\nconst a = 1;')).not.toContain('DELETE');
        expect(stripComments('const q = `DELETE FROM "Evidence"`;')).toContain('DELETE FROM');
    });

    test('no raw SQL DELETE against soft-delete tables outside of approved files', () => {
        // Approved files that may contain raw DELETE:
        const APPROVED_RAW_DELETE_FILES = new Set([
            'soft-delete-operations.ts', // purgeEntity uses raw DELETE
            'retention-purge.ts',         // purgeSoftDeletedOlderThan uses raw DELETE
            'data-lifecycle.ts',          // purgeSoftDeletedOlderThan + purgeExpiredEvidence use raw DELETE
            'soft-delete-lifecycle.ts',   // purgeSoftDeleted uses raw DELETE
        ]);

        const violations: string[] = [];

        for (const file of allFiles) {
            const basename = path.basename(file);
            if (APPROVED_RAW_DELETE_FILES.has(basename)) continue;

            // Strip comments first. This scans for a SQL string, and a
            // comment explaining why a raw DELETE is dangerous necessarily
            // contains that string — `evidence-bytes.ts` was flagged for a
            // docstring while containing no SQL at all. A guard that fires on
            // prose teaches people to stop writing the prose.
            const content = stripComments(fs.readFileSync(file, 'utf-8'));
            const relPath = path.relative(SRC_DIR, file);

            for (const model of SOFT_DELETE_MODELS) {
                // Check for raw DELETE FROM "Model"
                if (content.includes(`DELETE FROM "${model}"`)) {
                    violations.push(`${relPath}: contains raw DELETE FROM "${model}" — only approved in purge files`);
                }
            }
        }

        expect(violations).toEqual([]);
    });

    test('soft-delete extension wraps audit extension (composition order)', () => {
        // Prisma 7 — the v5 registration-order check was replaced by an
        // outer/inner composition check. The chain in prisma.ts is:
        //   withSoftDeleteExtension( base.$extends(buildAuditExtension()) )
        // so audit is innermost (closest to DB) and soft-delete is the
        // wrapper around it. delete → update transform happens BEFORE
        // audit sees the operation, so the audit row records the
        // resulting `update` not the original `delete`. This is the
        // load-bearing invariant.
        const content = fs.readFileSync(PRISMA_FILE, 'utf-8');
        const softDeleteIdx = content.indexOf('withSoftDeleteExtension(');
        // Anchor on the call site inside buildExtended (`base.$extends(
        // buildAuditExtension())`) — this is unique vs the audit
        // function declaration earlier in the file. The wrapping
        // `withSoftDeleteExtension(` call must appear BEFORE the inner
        // `base.$extends(buildAuditExtension())` it wraps in source
        // order — i.e. soft-delete is outside, audit is inside.
        const auditCallIdx = content.indexOf('base.$extends(buildAuditExtension())');

        expect(softDeleteIdx).toBeGreaterThan(-1);
        expect(auditCallIdx).toBeGreaterThan(-1);
        expect(softDeleteIdx).toBeLessThan(auditCallIdx);
    });

    test('SOFT_DELETE_MODELS allowlist has exactly 11 models', () => {
        const content = fs.readFileSync(SOFT_DELETE_FILE, 'utf-8');
        // Count the models in the Set
        const modelMatches = content.match(/'(Asset|Control|Evidence|Policy|Vendor|FileRecord|Task|Finding|Audit|AuditCycle|AuditPack)'/g);
        expect(modelMatches).not.toBeNull();
        expect(new Set(modelMatches).size).toBe(11);
    });

    test('withDeleted helper is exported from soft-delete.ts', () => {
        const content = fs.readFileSync(SOFT_DELETE_FILE, 'utf-8');
        expect(content).toContain('export function withDeleted');
    });

    test('retention-purge.ts exists and exports purgeSoftDeletedOlderThan', () => {
        const retentionFile = path.join(SRC_DIR, 'lib', 'retention-purge.ts');
        expect(fs.existsSync(retentionFile)).toBe(true);
        const content = fs.readFileSync(retentionFile, 'utf-8');
        expect(content).toContain('export async function purgeSoftDeletedOlderThan');
    });

    test('all 5 models have deletedAt field in schema', () => {
        const schema = readPrismaSchema();

        for (const model of SOFT_DELETE_MODELS) {
            // Find the model block and check it contains deletedAt
            const modelRegex = new RegExp(`model ${model} \\{[^}]+\\}`, 's');
            const match = schema.match(modelRegex);
            expect(match).not.toBeNull();
            expect(match![0]).toContain('deletedAt');
            expect(match![0]).toContain('deletedByUserId');
        }
    });
});
