/**
 * Audit Structured Events — Regression Guards
 *
 * Ensures that:
 * 1. All logEvent call sites include `detailsJson` (no bare free-form events)
 * 2. Audit inserts only go through the audit-writer (no raw INSERT)
 * 3. The verify-audit-chain script exists and is executable
 * 4. Common detailsJson payloads validate against the Zod schema
 *
 * ── Why guard 1 parses instead of slicing lines (issue #658) ─────────
 *
 * It used to take a FIXED 15-line slice from each `logEvent(` line and
 * truncate it at the first textual `});` via `String.indexOf`. That never
 * brace-matched, so it had no idea where the call actually ended, and it
 * broke in BOTH directions:
 *
 *   FALSE POSITIVE — a compliant call whose `detailsJson` sat past offset
 *   14 was reported as a violation. Not hypothetical: measured across the
 *   tree, the deepest `detailsJson` sits at offset 11 (`issue.ts`), so
 *   there were THREE lines of headroom. Adding a four-line explanatory
 *   comment inside a call body failed CI on correct code — which is
 *   exactly how this was found, while writing #646.
 *
 *   FALSE NEGATIVE — when no `});` fell inside the window, the snippet
 *   spilled into the NEXT call and inherited ITS `detailsJson`. A real
 *   usecase file with a real audit call shipping no structured payload
 *   passed, purely because it had a compliant neighbour.
 *
 * So the old guard's protection was contingent on FORMATTING, not on
 * structure. It now walks the TypeScript AST: a `logEvent` CallExpression
 * either has a `detailsJson` property or it does not, and no amount of
 * comment or reformatting changes the answer. `assertDetailsJson` is a pure
 * function over source text so the mutation proofs below can feed it
 * synthetic files — the guard tests its own detector rather than asserting
 * that it exists.
 *
 * ── Why the scan covers all of `src` ─────────────────────────────────
 *
 * It used to cover `src/app-layer/usecases` only. Seventeen real audit
 * calls live outside it, and SIX of them had no `detailsJson` at all:
 * four onboarding emitters plus the two key-rotation admin routes. That
 * matters because `streamAuditEvent` DROPS the free-text `details` field
 * and ships only the structured payload — so three onboarding events were
 * reaching a tenant's SIEM as an action verb and an entity id with no
 * content whatsoever. All six were fixed in the same change, which is why
 * this guard needs no baseline: it is 206 of 206.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { AuditDetailsSchema } from '../../src/lib/audit/event-schema';

const SRC_DIR = path.resolve(__dirname, '..', '..', 'src');
const SCRIPTS_DIR = path.resolve(__dirname, '..', '..', 'scripts');

/**
 * Floor on how many `logEvent` call sites the walker must find. Measured at
 * 206 when this landed; set below that so ordinary churn does not trip it,
 * but high enough that a matcher which stops matching fails instead of
 * reporting a clean tree.
 */
const MIN_EXPECTED_CALL_SITES = 150;

/**
 * Pure detector: given a file's source text, return every `logEvent(...)`
 * call that does not pass a `detailsJson` property, plus how many call sites
 * were seen at all.
 *
 * Only BARE `logEvent(...)` identifiers count. A member call like
 * `this.logEvent(...)` is a different function that happens to share the
 * name (see the sync-orchestrator note in the docblock).
 */
export function assertDetailsJson(
    displayPath: string,
    source: string,
): { violations: string[]; total: number } {
    const sf = ts.createSourceFile(displayPath, source, ts.ScriptTarget.Latest, true);
    const violations: string[] = [];
    let total = 0;

    const visit = (node: ts.Node): void => {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === 'logEvent'
        ) {
            total += 1;
            const hasDetailsJson = node.arguments.some(
                (arg) =>
                    ts.isObjectLiteralExpression(arg) &&
                    arg.properties.some(
                        (prop) =>
                            !!prop.name &&
                            ts.isIdentifier(prop.name) &&
                            prop.name.text === 'detailsJson',
                    ),
            );
            if (!hasDetailsJson) {
                const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
                violations.push(`${displayPath}:${line} — logEvent without detailsJson`);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);

    return { violations, total };
}

/** Recursively collect source files from a directory. */
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

    test('every logEvent call site in src/ passes detailsJson', () => {
        const files = collectFiles(SRC_DIR, ['.ts', '.tsx']);
        const violations: string[] = [];
        let callsSeen = 0;

        for (const file of files) {
            const content = fs.readFileSync(file, 'utf-8');
            // Cheap reject before parsing ~1900 files.
            if (!content.includes('logEvent')) continue;
            const found = assertDetailsJson(path.relative(SRC_DIR, file), content);
            callsSeen += found.total;
            violations.push(...found.violations);
        }

        // Resolving power: if the walker silently stopped finding call
        // sites, `violations` would be empty for the wrong reason. Pin a
        // floor so a broken matcher fails loudly instead of passing.
        expect(callsSeen).toBeGreaterThanOrEqual(MIN_EXPECTED_CALL_SITES);
        expect(violations).toEqual([]);
    });

    // The detector's own tests. These are the point of the rewrite: the
    // previous implementation would have failed the first and passed the
    // second, and nothing in the repo would have said so.
    describe('assertDetailsJson — mutation proofs', () => {
        const COMPLIANT = `
import { logEvent } from './audit';
export async function f(db: unknown, ctx: unknown) {
    await logEvent(db, ctx, {
        action: 'THING_HAPPENED',
        entityType: 'Thing',
        entityId: 'id-1',
        details: 'A thing happened',
        detailsJson: { category: 'custom', event: 'thing' },
    });
}
`;

        it('accepts a compliant call', () => {
            expect(assertDetailsJson('probe.ts', COMPLIANT).violations).toEqual([]);
        });

        it('rejects a call with no detailsJson', () => {
            const src = COMPLIANT.replace(
                "        detailsJson: { category: 'custom', event: 'thing' },\n",
                '',
            );
            expect(assertDetailsJson('probe.ts', src).violations).toHaveLength(1);
        });

        it('accepts a compliant call whose detailsJson sits far below the call line', () => {
            // THE FALSE POSITIVE the old 15-line window produced. The call is
            // correct; `detailsJson` simply sits past offset 14.
            const filler = Array.from({ length: 20 }, (_, i) => `        // padding line ${i}`).join('\n');
            const src = COMPLIANT.replace(
                "        detailsJson:",
                `${filler}\n        detailsJson:`,
            );
            expect(assertDetailsJson('probe.ts', src).violations).toEqual([]);
        });

        it('rejects a non-compliant call even when a compliant one follows it', () => {
            // THE FALSE NEGATIVE. The old guard's snippet spilled into the
            // next call and borrowed its `detailsJson`, so this passed.
            const src = `
import { logEvent } from './audit';
export async function f(db: unknown, ctx: unknown) {
    await logEvent(db, ctx, buildAuditEvent('id-1'));
    await logEvent(db, ctx, {
        action: 'OTHER',
        entityType: 'Thing',
        entityId: 'id-2',
        detailsJson: { category: 'custom', event: 'other' },
    });
}
`;
            const out = assertDetailsJson('probe.ts', src);
            expect(out.total).toBe(2);
            expect(out.violations).toHaveLength(1);
            expect(out.violations[0]).toContain('probe.ts:4');
        });

        it('ignores a same-named METHOD call', () => {
            // `src/app-layer/integrations/sync-orchestrator.ts` has nine
            // `this.logEvent(...)` calls. They are a private method on the
            // orchestrator, not the audit writer, and counting them would
            // manufacture nine violations that mean nothing. A matcher that
            // greps for `logEvent(` cannot tell the difference.
            const src = `
class Orchestrator {
    private logEvent(id: string, dir: string) { void id; void dir; }
    run() { this.logEvent('a', 'PUSH'); }
}
`;
            expect(assertDetailsJson('probe.ts', src).total).toBe(0);
        });
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
