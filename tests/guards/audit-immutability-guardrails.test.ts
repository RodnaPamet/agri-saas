/**
 * AuditLog Immutability — Architectural Guardrails
 *
 * Static analysis tests ensuring no application code ever attempts
 * to UPDATE or DELETE AuditLog rows. This is complementary to the
 * DB trigger — the trigger is the enforcement point, but catching
 * violations at code-level prevents runtime surprises.
 */
import * as fs from 'fs';
import * as path from 'path';

import { collectSourceFiles } from '../helpers/collect-files';

const SRC_DIR = path.resolve(__dirname, '..', '..', 'src');
const PRISMA_DIR = path.resolve(__dirname, '..', '..', 'prisma');

/**
 * Every `.ts`/`.tsx` file under `src/`, absolute (each test relativises against
 * SRC_DIR for its report).
 *
 * Collected through `collectSourceFiles` so an EMPTY result fails (#865). All
 * four scans below end in `expect(violations).toEqual([])`, which is satisfied
 * by a collector that found nothing — a renamed `src/` would have retired the
 * whole AuditLog-immutability check without turning anything red.
 * The floor sits well under the 1958 files present today.
 */
function srcFiles(): string[] {
    return collectSourceFiles({ roots: ['src'], floor: 1000 });
}

describe('AuditLog Immutability Guardrails', () => {
    test('no application code calls auditLog.update or auditLog.updateMany', () => {
        const files = srcFiles();
        const violations: string[] = [];

        for (const file of files) {
            const content = fs.readFileSync(file, 'utf-8');
            const basename = path.relative(SRC_DIR, file);

            // Match Prisma-style calls: auditLog.update, auditLog.updateMany
            if (/auditLog\.(update|updateMany)\s*\(/.test(content)) {
                violations.push(`${basename}: contains auditLog.update/updateMany call`);
            }
        }

        expect(violations).toEqual([]);
    });

    test('no application code calls auditLog.delete or auditLog.deleteMany', () => {
        const files = srcFiles();
        const violations: string[] = [];

        for (const file of files) {
            const content = fs.readFileSync(file, 'utf-8');
            const basename = path.relative(SRC_DIR, file);

            if (/auditLog\.(delete|deleteMany)\s*\(/.test(content)) {
                violations.push(`${basename}: contains auditLog.delete/deleteMany call`);
            }
        }

        expect(violations).toEqual([]);
    });

    test('no raw SQL UPDATE on AuditLog table in application code', () => {
        const files = srcFiles();
        const violations: string[] = [];

        for (const file of files) {
            const content = fs.readFileSync(file, 'utf-8');
            const basename = path.relative(SRC_DIR, file);

            // Match UPDATE "AuditLog" in raw SQL strings
            if (/UPDATE\s+["']?AuditLog["']?/i.test(content)) {
                violations.push(`${basename}: contains raw SQL UPDATE on AuditLog`);
            }
        }

        expect(violations).toEqual([]);
    });

    test('no raw SQL DELETE on AuditLog table in application code', () => {
        const files = srcFiles();
        const violations: string[] = [];

        for (const file of files) {
            const content = fs.readFileSync(file, 'utf-8');
            const basename = path.relative(SRC_DIR, file);

            // Match DELETE FROM "AuditLog" in raw SQL strings
            if (/DELETE\s+(FROM\s+)?["']?AuditLog["']?/i.test(content)) {
                violations.push(`${basename}: contains raw SQL DELETE on AuditLog`);
            }
        }

        expect(violations).toEqual([]);
    });

    test('Prisma audit middleware excludes AuditLog from WRITE_ACTIONS', () => {
        const prismaFile = path.resolve(SRC_DIR, 'lib', 'prisma.ts');
        const content = fs.readFileSync(prismaFile, 'utf-8');

        // The EXCLUDED_MODELS set must include 'AuditLog'
        expect(content).toMatch(/EXCLUDED_MODELS.*=.*new\s+Set\(\[[\s\S]*?'AuditLog'/);
    });

    test('migration file for immutability trigger exists', () => {
        const migrationDir = path.join(PRISMA_DIR, 'migrations');
        const dirs = fs.readdirSync(migrationDir);
        const immutableMigration = dirs.find(d => d.includes('audit_log_immutable'));

        expect(immutableMigration).toBeDefined();

        // Verify it contains the trigger function and trigger creation
        const sqlFile = path.join(migrationDir, immutableMigration!, 'migration.sql');
        const sql = fs.readFileSync(sqlFile, 'utf-8');

        expect(sql).toContain('audit_log_immutable_guard');
        expect(sql).toContain('BEFORE UPDATE OR DELETE');
        expect(sql).toContain('IMMUTABLE_AUDIT_LOG');
        expect(sql).toContain('REVOKE UPDATE');
        expect(sql).toContain('REVOKE');
    });
});
