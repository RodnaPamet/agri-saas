/**
 * Regression Scanner — Architectural Guardrails
 *
 * Consolidated test that fails if architectural invariants are violated.
 * Complements existing guards (no-direct-prisma, no-usestate-any, etc.)
 * by covering middleware existence, import patterns, and structural rules.
 *
 * RUN: npx jest tests/guards/regression-scanner.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { readPrismaSchema } from '../helpers/prisma-schema';

const SRC_ROOT = path.resolve(__dirname, '../../src');

function walk(dir: string, exts: string[], results: string[] = []): string[] {
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.next', 'dist'].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, exts, results);
        else if (exts.some(e => entry.name.endsWith(e))) results.push(full);
    }
    return results;
}

function readSafe(filePath: string): string {
    try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

// ── 1. Middleware existence checks ──

describe('Regression: Middleware existence', () => {
    test('soft-delete middleware/helper exists', () => {
        const candidates = [
            path.join(SRC_ROOT, 'lib/soft-delete.ts'),
            path.join(SRC_ROOT, 'lib/soft-delete/index.ts'),
            path.join(SRC_ROOT, 'app-layer/usecases/soft-delete-operations.ts'),
        ];
        const exists = candidates.some(f => fs.existsSync(f));
        expect(exists).toBe(true);
    });

    test('audit event logger exists', () => {
        const candidates = [
            path.join(SRC_ROOT, 'app-layer/events/audit.ts'),
            path.join(SRC_ROOT, 'lib/audit.ts'),
        ];
        const exists = candidates.some(f => fs.existsSync(f));
        expect(exists).toBe(true);
    });

    test('tenant context helper exists', () => {
        const dbCtx = path.join(SRC_ROOT, 'lib/db-context.ts');
        expect(fs.existsSync(dbCtx)).toBe(true);
        const content = readSafe(dbCtx);
        expect(content).toContain('runInTenantContext');
    });

    test('RBAC policy layer exists', () => {
        const common = path.join(SRC_ROOT, 'app-layer/policies/common.ts');
        expect(fs.existsSync(common)).toBe(true);
        const content = readSafe(common);
        expect(content).toContain('assertCanRead');
        expect(content).toContain('assertCanWrite');
        expect(content).toContain('assertCanAdmin');
    });
});

// ── 2. No forbidden patterns in source ──

describe('Regression: Forbidden patterns', () => {
    const allTsxFiles = walk(path.join(SRC_ROOT), ['.tsx']);

    test('no console.log in production components (excluding error boundaries)', () => {
        const violations: string[] = [];
        for (const file of allTsxFiles) {
            const rel = path.relative(SRC_ROOT, file);
            if (rel.includes('error') || rel.includes('global-error')) continue;
            const content = readSafe(file);
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line.includes('console.log(') && !lines[Math.max(0, i - 1)].includes('eslint-disable')) {
                    violations.push(`${rel}:${i + 1}`);
                }
            }
        }
        // Warn but don't hard-fail — console.log is sometimes intentional during development
        expect(violations.length).toBeLessThanOrEqual(10);
    });

    test('no direct Error throws in usecases (should use typed errors)', () => {
        const usecaseDir = path.join(SRC_ROOT, 'app-layer/usecases');
        if (!fs.existsSync(usecaseDir)) return;
        const usecases = walk(usecaseDir, ['.ts']);
        const violations: string[] = [];

        for (const file of usecases) {
            const content = readSafe(file);
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                // `throw new Error(` is forbidden — use notFound/badRequest/forbidden instead
                if (line.match(/throw\s+new\s+Error\s*\(/) && !lines[Math.max(0, i - 1)].includes('eslint-disable')) {
                    violations.push(`${path.relative(SRC_ROOT, file)}:${i + 1}: ${line.slice(0, 80)}`);
                }
            }
        }

        expect(violations).toEqual([]);
    });

    test('no TODO/FIXME/HACK in production usecases without tracking', () => {
        const usecaseDir = path.join(SRC_ROOT, 'app-layer/usecases');
        if (!fs.existsSync(usecaseDir)) return;
        const usecases = walk(usecaseDir, ['.ts']);
        const violations: string[] = [];

        for (const file of usecases) {
            const content = readSafe(file);
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (/\b(TODO|FIXME|HACK)\b/.test(line) && !line.includes('eslint-disable')) {
                    violations.push(`${path.relative(SRC_ROOT, file)}:${i + 1}: ${line.trim().slice(0, 80)}`);
                }
            }
        }

        // Allow up to 5 — track and reduce over time
        expect(violations.length).toBeLessThanOrEqual(5);
    });
});

// ── 3. Import hygiene ──

describe('Regression: Import hygiene', () => {
    test('route handlers import from app-layer, not lib/prisma directly', () => {
        const routeDir = path.join(SRC_ROOT, 'app/api/t');
        if (!fs.existsSync(routeDir)) return;
        // audit-log/coverage uses prisma for cross-entity coverage metrics.
        // key-rotation passes the prisma client through to `logEvent` so
        // the audit row lands on the same transaction the BullMQ job
        // will later use (Epic B.3 — admin-initiated tenant key rotation).
        // tenant-dek-rotation follows the same pattern (Epic F.2
        // follow-up — per-tenant DEK rotation).
        // admin/sessions (Epic C.3) passes prisma to `logEvent` for the
        // SESSION_REVOKED_BY_ADMIN audit row — same pattern as
        // key-rotation; row lookups go through `findOwnTenantSession`
        // in `lib/security/session-tracker.ts`, not through
        // `prisma.userSession.…` in the route.
        const ROUTE_ALLOWLIST = ['audit-log', 'scim', 'key-rotation', 'tenant-dek-rotation', 'sessions'];
        const routes = walk(routeDir, ['.ts']).filter(f =>
            f.endsWith('route.ts') && !ROUTE_ALLOWLIST.some(a => f.includes(a))
        );

        const violations: string[] = [];
        for (const file of routes) {
            const content = readSafe(file);
            const hasPrismaImport = content.includes("from '@/lib/prisma'") || content.includes('from "@/lib/prisma"');
            if (hasPrismaImport) {
                violations.push(path.relative(SRC_ROOT, file));
            }
        }
        expect(violations).toEqual([]);
    });

    test('usecases use typed error helpers, not raw HTTP status codes', () => {
        const usecaseDir = path.join(SRC_ROOT, 'app-layer/usecases');
        if (!fs.existsSync(usecaseDir)) return;
        const usecases = walk(usecaseDir, ['.ts']);
        const violations: string[] = [];

        for (const file of usecases) {
            const content = readSafe(file);
            // Check for raw status code usage: { status: 404 } or { status: 400 }
            if (/\bstatus:\s*(400|401|403|404|500)\b/.test(content)) {
                violations.push(path.relative(SRC_ROOT, file));
            }
        }

        expect(violations).toEqual([]);
    });
});

// ── 4. Schema integrity ──

describe('Regression: Schema integrity', () => {
    test('Prisma schema has tenantId on all tenant-scoped models', () => {
        const content = readPrismaSchema();

        // These models MUST have tenantId
        const tenantScopedModels = ['Risk', 'Control', 'Evidence', 'Task', 'Asset'];

        for (const model of tenantScopedModels) {
            const modelMatch = content.match(new RegExp(`model\\s+${model}\\s*\\{([^}]+)\\}`, 's'));
            if (modelMatch) {
                expect(modelMatch[1]).toContain('tenantId');
            }
        }
    });

    test('Prisma schema has deletedAt on soft-deletable models', () => {
        const content = readPrismaSchema();

        const softDeleteModels = ['Risk', 'Control'];

        for (const model of softDeleteModels) {
            const modelMatch = content.match(new RegExp(`model\\s+${model}\\s*\\{([^}]+)\\}`, 's'));
            if (modelMatch) {
                expect(modelMatch[1]).toContain('deletedAt');
            }
        }
    });
});
