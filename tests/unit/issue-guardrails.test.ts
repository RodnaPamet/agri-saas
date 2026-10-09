/**
 * CI Guardrail Tests — Issue → Task Migration
 *
 * These tests scan the codebase to ensure that legacy Issue model references
 * do not creep back in. They enforce "Tasks are the only work item."
 *
 * #1479 finished the migration these guardrails were written during. The
 * `/issues/**` route surface, `usecases/issue.ts`, `policies/issue.policies.ts`
 * and both deprecated repositories are gone, so `ALLOWED_LEGACY_FILES` shrank
 * from five entries to one.
 *
 * The route assertion changed SHAPE at the same time, and that is the
 * load-bearing part. It read:
 *
 *     if (!fs.existsSync(issueRoutesDir)) return; // routes already removed
 *
 * — so the moment the retirement it was anticipating actually happened, the
 * test would pass by not running, and nothing would stop the surface coming
 * back. It asserts the directory's ABSENCE now. An early return that
 * anticipates a future deletion becomes a silent pass on the day of it.
 */
import fs from 'fs';
import path from 'path';
import { readPrismaSchema } from '../helpers/prisma-schema';

const SRC_DIR = path.resolve(__dirname, '../../src');

function grepFiles(pattern: RegExp, dir: string, extensions: string[]): { file: string; line: number; content: string }[] {
    const results: { file: string; line: number; content: string }[] = [];
    const walk = (d: string) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) {
                if (['node_modules', '.next', '.git', 'dist'].includes(entry.name)) continue;
                walk(full);
            } else if (extensions.some(ext => entry.name.endsWith(ext))) {
                const content = fs.readFileSync(full, 'utf-8');
                content.split('\n').forEach((line, i) => {
                    if (pattern.test(line)) {
                        results.push({ file: path.relative(SRC_DIR, full), line: i + 1, content: line.trim() });
                    }
                });
            }
        }
    };
    walk(dir);
    return results;
}

// Allowed files that contain legacy Issue references as shims/compatibility wrappers
const ALLOWED_LEGACY_FILES = [
    // The other four entries (`repositories/IssueRepository.ts`,
    // `repositories/EvidenceBundleRepository.ts`, `usecases/issue.ts`,
    // `policies/issue.policies.ts`) were deleted by #1479. This list is
    // SHRINK-ONLY: an addition means a new file carrying legacy Issue
    // references, which is the thing these guardrails exist to prevent.
    'events/audit.ts',                     // event names
];

function isAllowed(file: string): boolean {
    return ALLOWED_LEGACY_FILES.some(allowed => file.replace(/\\/g, '/').endsWith(allowed));
}

describe('Issue → Task Migration Guardrails', () => {
    test('Prisma schema must NOT contain Issue model', () => {
        const schema = readPrismaSchema();
        const issueModels = schema.match(/^model\s+(Issue|IssueLink|IssueComment|IssueWatcher|IssueEvidenceBundle)\s*\{/gm);
        expect(issueModels).toBeNull();
    });

    test('No code references db.issue (raw Prisma Issue model access)', () => {
        const hits = grepFiles(/\bdb\.issue\b(?!s)/, SRC_DIR, ['.ts', '.tsx'])
            .filter(h => !isAllowed(h.file));
        if (hits.length > 0) {
            const summary = hits.map(h => `  ${h.file}:${h.line}  ${h.content}`).join('\n');
            fail(`Found ${hits.length} references to db.issue (should use db.task):\n${summary}`);
        }
    });

    test('No code references db.issueLink/db.issueComment/db.issueWatcher', () => {
        const hits = grepFiles(/\bdb\.(issueLink|issueComment|issueWatcher|issueEvidenceBundle)\b/, SRC_DIR, ['.ts', '.tsx'])
            .filter(h => !isAllowed(h.file));
        if (hits.length > 0) {
            const summary = hits.map(h => `  ${h.file}:${h.line}  ${h.content}`).join('\n');
            fail(`Found references to legacy Issue sub-models:\n${summary}`);
        }
    });

    test('No new Prisma model with "Issue" in the name', () => {
        const schema = readPrismaSchema();
        const models = schema.match(/^model\s+\w*Issue\w*\s*\{/gm);
        expect(models).toBeNull();
    });

    test('the /issues API surface is GONE and does not come back', () => {
        // Was: `if (!existsSync(dir)) return;` — which turned into a silent
        // pass the day #1479 removed the directory, leaving nothing to stop a
        // reinstatement. The absence is the assertion now.
        //
        // 15 routes wrote `Task` rows through a usecase layer that never
        // invalidated the task cache and stamped its audit rows
        // `entityType: 'Issue'` — a model the schema does not have. Three of
        // them served a stubbed `EvidenceBundleRepository` whose list methods
        // returned `[]`, so a client was told an issue had no evidence bundles
        // rather than that bundles do not exist.
        const issueRoutesDir = path.join(SRC_DIR, 'app/api/t/[tenantSlug]/issues');
        expect(fs.existsSync(issueRoutesDir)).toBe(false);
    });

    test('no module re-exports the retired Issue usecase, policy or repositories', () => {
        // The deletion's own ratchet. Each of these was a live file until
        // #1479, and each is the kind a future reader could recreate as a
        // "compatibility shim" without knowing the surface was retired
        // deliberately.
        for (const gone of [
            'app-layer/usecases/issue.ts',
            'app-layer/policies/issue.policies.ts',
            'app-layer/repositories/IssueRepository.ts',
            'app-layer/repositories/EvidenceBundleRepository.ts',
        ]) {
            expect(fs.existsSync(path.join(SRC_DIR, gone))).toBe(false);
        }
    });

    test('Tasks are the only work item: no model creates Issue-based entities', () => {
        const hits = grepFiles(/prisma\.issue\.create|prisma\.issueLink\.create|prisma\.issueComment\.create/, SRC_DIR, ['.ts', '.tsx']);
        expect(hits.length).toBe(0);
    });
});
