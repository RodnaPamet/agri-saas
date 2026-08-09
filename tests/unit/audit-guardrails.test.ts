/**
 * Static analysis guardrails for audit middleware completeness.
 *
 * These tests scan the codebase to verify:
 * 1. Prisma client module registers $use audit middleware
 * 2. No new code calls the deprecated logAudit() function
 * 3. No code creates PrismaClient without middleware
 * 4. No code directly writes to domain tables via raw SQL without audit
 *
 * RUN: npx jest tests/unit/audit-guardrails.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC_DIR = path.resolve(__dirname, '../../src');

function readFile(relPath: string): string {
    return fs.readFileSync(path.resolve(SRC_DIR, relPath), 'utf8');
}

/**
 * Recursively collect all .ts/.tsx files under a directory.
 */
function collectTsFiles(dir: string, results: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.next') {
            collectTsFiles(fullPath, results);
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
            results.push(fullPath);
        }
    }
    return results;
}

describe('Audit Guardrails — Middleware Registration', () => {
    const prismaModule = readFile('lib/prisma.ts');

    it('prisma.ts wires the audit extension via $extends', () => {
        // Prisma 7 — `$use` was removed; the audit middleware is now
        // a `client.$extends({ query: { $allModels: ... } })`
        // extension. Pin the new wiring so a future PR can't strip
        // it silently.
        expect(prismaModule).toContain('$extends(');
    });

    it('prisma.ts builds the audit extension from buildAuditExtension', () => {
        // Was `registerAuditMiddleware` in Prisma 5; renamed to
        // `buildAuditExtension` (factory returning the extension
        // descriptor) in the Prisma 7 migration.
        expect(prismaModule).toContain('buildAuditExtension');
    });

    it('prisma.ts excludes AuditLog model to prevent recursion', () => {
        expect(prismaModule).toContain("'AuditLog'");
    });

    it('prisma.ts has Edge Runtime guard', () => {
        expect(prismaModule).toContain('EdgeRuntime');
    });

    it('prisma.ts imports getAuditContext for context capture', () => {
        expect(prismaModule).toContain('getAuditContext');
    });

    it('prisma.ts imports redaction utilities', () => {
        expect(prismaModule).toContain('redactSensitiveFields');
    });

    it('prisma.ts captures all 7 write actions', () => {
        const requiredActions = ['create', 'createMany', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert'];
        for (const action of requiredActions) {
            expect(prismaModule).toContain(`'${action}'`);
        }
    });
});

describe('Audit Guardrails — No Deprecated logAudit Usage', () => {
    const ALLOWED_FILES = [
        // The deprecated wrapper itself
        path.resolve(SRC_DIR, 'lib', 'audit-log.ts'),
    ];

    it('no source file (except audit-log.ts) calls logAudit()', () => {
        const allFiles = collectTsFiles(SRC_DIR);
        const violations: string[] = [];

        for (const file of allFiles) {
            if (ALLOWED_FILES.includes(file)) continue;

            const content = fs.readFileSync(file, 'utf8');
            if (content.includes('logAudit(')) {
                violations.push(path.relative(SRC_DIR, file));
            }
        }

        expect(violations).toEqual([]);
    });
});

describe('Audit Guardrails — No Raw PrismaClient Without Middleware', () => {
    it('no source file creates new PrismaClient() outside lib/prisma.ts', () => {
        const allFiles = collectTsFiles(SRC_DIR);
        const ALLOWED_FILES = [
            path.resolve(SRC_DIR, 'lib', 'prisma.ts'),
            // Infrastructure routes create standalone PrismaClient for health/seed checks
            path.resolve(SRC_DIR, 'app', 'api', 'health', 'route.ts'),
            path.resolve(SRC_DIR, 'app', 'api', 'readyz', 'route.ts'),
            path.resolve(SRC_DIR, 'app', 'api', 'staging', 'seed', 'route.ts'),
        ];

        const violations: string[] = [];

        for (const file of allFiles) {
            if (ALLOWED_FILES.includes(file)) continue;

            const content = fs.readFileSync(file, 'utf8');
            if (content.includes('new PrismaClient(')) {
                violations.push(path.relative(SRC_DIR, file));
            }
        }

        expect(violations).toEqual([]);
    });
});

describe('Audit Guardrails — No Unaudited Raw SQL to Domain Tables', () => {
    it('no source file uses $executeRaw to INSERT into domain tables without audit', () => {
        const allFiles = collectTsFiles(SRC_DIR);
        const ALLOWED_FILES = [
            // The audit middleware itself uses $executeRawUnsafe for AuditLog INSERTs
            path.resolve(SRC_DIR, 'lib', 'prisma.ts'),
        ];

        const DOMAIN_TABLES = [
            'Risk', 'Practice', 'Asset', 'Policy', 'Vendor',
            'Issue', 'Framework', 'Task', 'Tenant', 'User',
        ];

        const violations: string[] = [];

        for (const file of allFiles) {
            if (ALLOWED_FILES.includes(file)) continue;

            const content = fs.readFileSync(file, 'utf8');
            if (content.includes('$executeRaw')) {
                // Check if the raw SQL targets a domain table (INSERT/UPDATE/DELETE)
                for (const table of DOMAIN_TABLES) {
                    const pattern = new RegExp(`\\$executeRaw.*(?:INSERT|UPDATE|DELETE).*"${table}"`, 'i');
                    if (pattern.test(content)) {
                        violations.push(`${path.relative(SRC_DIR, file)} → raw SQL targeting "${table}"`);
                    }
                }
            }
        }

        expect(violations).toEqual([]);
    });
});
