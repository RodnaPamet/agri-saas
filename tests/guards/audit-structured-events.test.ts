/**
 * Audit Structured Events — Regression Guards
 *
 * Ensures that:
 * 1. All logEvent call sites include `detailsJson` (no bare free-form events)
 * 2. Audit inserts only go through the audit-writer (no raw INSERT)
 * 3. The verify-audit-chain script exists and is executable
 * 4. Common detailsJson payloads validate against the Zod schema
 */
import * as fs from 'fs';
import * as path from 'path';
import { AuditDetailsSchema } from '../../src/lib/audit/event-schema';

const SRC_DIR = path.resolve(__dirname, '..', '..', 'src');
const SCRIPTS_DIR = path.resolve(__dirname, '..', '..', 'scripts');
const USECASES_DIR = path.resolve(SRC_DIR, 'app-layer', 'usecases');

/** Recursively collect .ts files from a directory. */
function collectFiles(dir: string, exts = ['.ts']): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            results.push(...collectFiles(full, exts));
        } else if (entry.isFile() && exts.some(ext => entry.name.endsWith(ext))) {
            results.push(full);
        }
    }
    return results;
}

describe('Audit Structured Events — Regression Guards', () => {

    // ── Guard 1: All logEvent calls should have detailsJson ──

    test('all logEvent calls in usecases include detailsJson', () => {
        const files = collectFiles(USECASES_DIR);
        const violations: string[] = [];

        for (const file of files) {
            const content = fs.readFileSync(file, 'utf-8');
            const basename = path.relative(SRC_DIR, file);

            // Find all logEvent calls
            const lines = content.split('\n');

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                // Only match actual call sites: "await logEvent(" or "logEvent(db"
                // Skip imports, comments, function definitions, and test files
                const isCallSite = /await\s+logEvent\s*\(/.test(line) || /logEvent\s*\(\s*(?:db|tdb)/.test(line);
                if (!isCallSite) continue;
                if (line.includes('detailsJson')) continue;

                // Check if detailsJson appears in the multi-line call body
                const context = lines.slice(i, Math.min(i + 15, lines.length)).join('\n');
                const closingIdx = context.indexOf('});');
                const callSnippet = closingIdx >= 0 ? context.substring(0, closingIdx + 3) : context;

                if (!callSnippet.includes('detailsJson')) {
                    violations.push(`${basename}:${i + 1} — logEvent without detailsJson`);
                }
            }
        }

        expect(violations).toEqual([]);
    });

    // ── Guard 2: No raw INSERT into AuditLog outside audit-writer ──

    test('no raw SQL INSERT into AuditLog outside audit-writer.ts', () => {
        const files = collectFiles(SRC_DIR);
        const violations: string[] = [];

        for (const file of files) {
            const basename = path.relative(SRC_DIR, file);
            // Skip the audit writer itself (it's the ONE place that does raw INSERT)
            if (basename.includes('audit-writer') || basename.includes('audit/verify')) continue;

            const content = fs.readFileSync(file, 'utf-8');
            if (/INSERT\s+INTO\s+[\"']?AuditLog[\"']?/i.test(content)) {
                violations.push(`${basename}: contains raw INSERT INTO AuditLog`);
            }
        }

        expect(violations).toEqual([]);
    });

    // ── Guard 3: verify-audit-chain script exists ──

    test('verify-audit-chain.ts script exists', () => {
        const scriptPath = path.join(SCRIPTS_DIR, 'verify-audit-chain.ts');
        expect(fs.existsSync(scriptPath)).toBe(true);

        const content = fs.readFileSync(scriptPath, 'utf-8');
        expect(content).toContain('verifyTenantChain');
        expect(content).toContain('verifyAllTenants');
        expect(content).toContain('--tenant');
        expect(content).toContain('--json');
    });

    // ── Guard 4: verify.ts reusable module exists ──

    test('verify.ts reusable module exists with correct exports', () => {
        const verifyPath = path.resolve(SRC_DIR, 'lib', 'audit', 'verify.ts');
        expect(fs.existsSync(verifyPath)).toBe(true);

        const content = fs.readFileSync(verifyPath, 'utf-8');
        expect(content).toContain('export async function verifyTenantChain');
        expect(content).toContain('export async function verifyAllTenants');
        expect(content).toContain('BreakType');
        expect(content).toContain('VerificationReport');
    });

    // ── Guard 5: Core event payloads validate against Zod schema ──

    describe('detailsJson schema validation', () => {
        test('entity_lifecycle payload validates', () => {
            const payload = {
                category: 'entity_lifecycle',
                entityName: 'Practice',
                operation: 'created',
                after: { name: 'Test Practice' },
                summary: 'Created practice',
            };
            const result = AuditDetailsSchema.safeParse(payload);
            expect(result.success).toBe(true);
        });

        test('status_change payload validates', () => {
            const payload = {
                category: 'status_change',
                entityName: 'Policy',
                fromStatus: 'DRAFT',
                toStatus: 'IN_REVIEW',
                reason: 'Approval requested',
            };
            const result = AuditDetailsSchema.safeParse(payload);
            expect(result.success).toBe(true);
        });

        test('access payload validates', () => {
            const payload = {
                category: 'access',
                operation: 'login',
                detail: 'MFA challenge passed',
            };
            const result = AuditDetailsSchema.safeParse(payload);
            expect(result.success).toBe(true);
        });

        test('data_lifecycle payload validates', () => {
            const payload = {
                category: 'data_lifecycle',
                operation: 'purged',
                model: 'Evidence',
                reason: 'Retention expired',
            };
            const result = AuditDetailsSchema.safeParse(payload);
            expect(result.success).toBe(true);
        });

        test('custom payload validates', () => {
            const payload = {
                category: 'custom',
                event: 'due_planning_executed',
                checked: 10,
                created: 3,
            };
            const result = AuditDetailsSchema.safeParse(payload);
            expect(result.success).toBe(true);
        });

        test('invalid category is rejected', () => {
            const payload = {
                category: 'unknown_category',
                entityName: 'Something',
            };
            const result = AuditDetailsSchema.safeParse(payload);
            expect(result.success).toBe(false);
        });

        test('missing required fields rejected', () => {
            const payload = {
                category: 'entity_lifecycle',
                // missing entityName and operation
            };
            const result = AuditDetailsSchema.safeParse(payload);
            expect(result.success).toBe(false);
        });
    });
});
