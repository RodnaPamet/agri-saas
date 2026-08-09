/**
 * CI Guardrail: prevent new unsafe `any` patterns in source code.
 *
 * These tests scan the codebase and fail if unsafe patterns exceed thresholds.
 * As the codebase is cleaned up, thresholds should ratchet down.
 */
import * as fs from 'fs';
import * as path from 'path';

function scanFiles(dir: string, extensions: string[]): string[] {
    const results: string[] = [];
    function walk(d: string) {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === '.next') continue;
                walk(full);
            } else if (extensions.some(ext => entry.name.endsWith(ext))) {
                results.push(full);
            }
        }
    }
    walk(dir);
    return results;
}

interface Violation { file: string; line: number; text: string }

function grepPattern(files: string[], pattern: RegExp): Violation[] {
    const violations: Violation[] = [];
    for (const file of files) {
        const content = fs.readFileSync(file, 'utf-8');
        content.split('\n').forEach((text, idx) => {
            if (pattern.test(text)) {
                violations.push({ file: path.relative(process.cwd(), file), line: idx + 1, text: text.trim() });
            }
        });
    }
    return violations;
}

const SRC_DIR = path.join(process.cwd(), 'src');
const srcFiles = scanFiles(SRC_DIR, ['.ts', '.tsx']);
const routeFiles = srcFiles.filter(f => f.includes(path.sep + 'api' + path.sep) && f.endsWith('route.ts'));
const hookFiles = srcFiles.filter(f => f.includes(path.join('lib', 'hooks')));

describe('No unsafe any — CI Guardrails', () => {
    test('useState<any> must not exist in hooks', () => {
        const violations = grepPattern(hookFiles, /useState<any>/);
        expect(violations).toEqual([]);
    });

    test('useState<any> count is within threshold in src/', () => {
        // Current baseline: 31. As pages are migrated to hooks, this number should drop.
        // Ratchet this down as cleanup progresses.
        const THRESHOLD = 40;
        const violations = grepPattern(srcFiles, /useState<any>/);
        if (violations.length > THRESHOLD) {
            const summary = violations.slice(0, 5).map(v => `  ${v.file}:${v.line}`).join('\n');
            fail(`useState<any> count (${violations.length}) exceeds threshold (${THRESHOLD}).\nFirst 5:\n${summary}`);
        }
    });

    test('as any count in route handlers is within threshold (ratchet)', () => {
        // Current baseline: 16. As routes are migrated to proper DTO types,
        // ratchet this down. Once all routes are typed, change to 0.
        // Bumped for Epic 7: AV webhook + storage routes use dynamic Prisma access.
        const THRESHOLD = 25;
        const violations = grepPattern(routeFiles, /as any/);
        if (violations.length > THRESHOLD) {
            const summary = violations.slice(0, 5).map(v => `  ${v.file}:${v.line}: ${v.text}`).join('\n');
            fail(`"as any" in routes (${violations.length}) exceeds threshold (${THRESHOLD}):\n${summary}`);
        }
    });

    test(': any count is within threshold in src/ (ratchet)', () => {
        // Current baseline: ~347. Increased from ~301 due to Epic 1 RLS refactoring
        // (runInTenantContext erases Prisma type inference, requiring explicit casts).
        // Bumped for Epic 7: FileRepository scan lifecycle + AV webhook.
        // Bumped for data portability: export-service dynamic Prisma model access.
        // Bumped for RequirementMapping: dynamic where clause construction.
        // Bumped for reverse-direction edge loading (findByTargetRequirement).
        // Bumped for Epic 20: CI hardening integration sync additions.
        // Bumped for Epic 21: api-key-auth.ts scope-to-permission dynamic mapping.
        // Bumped for Epic 22: next-intl Translator type annotations on dashboard page.
        // Bumped for Epic 23: usecase decomposition redistributed existing any casts across submodule files.
        // Bumped for Epic 51: Dub-ported UI components and design system primitives.
        // Bumped for Epics 52–55: custom roles, API keys, compliance snapshots, lifecycle versioning.
        // Bumped +2 for bcryptjs ESM/CJS interop normalisation:
        //   - src/lib/auth/passwords.ts (canonical helper)
        //   - src/lib/auth.ts (legacy helper)
        // Each adds one `: any` annotation on the namespace cast — closes the
        // every-credentials-login-fails regression on Node ≥ 22.
        const THRESHOLD = 483;
        const violations = grepPattern(srcFiles, /:\s*any\b/);
        if (violations.length > THRESHOLD) {
            fail(`: any count (${violations.length}) exceeds threshold (${THRESHOLD})`);
        }
    });

    test('no new @ts-ignore (use @ts-expect-error with reason)', () => {
        const violations = grepPattern(srcFiles, /@ts-ignore/);
        expect(violations).toEqual([]);
    });

    test('response DTO files exist for all core domains', () => {
        const dtoDir = path.join(SRC_DIR, 'lib', 'dto');
        const required = [
            'control.dto.ts',
            'policy.dto.ts',
            'task.dto.ts',
            'vendor.dto.ts',
            'framework.dto.ts',
            'audit.dto.ts',
            'asset.dto.ts',
            'evidence.dto.ts',
        ];
        for (const file of required) {
            expect(fs.existsSync(path.join(dtoDir, file))).toBe(true);
        }
    });

    test('typed hook files exist for all core domains', () => {
        const hooksDir = path.join(SRC_DIR, 'lib', 'hooks');
        const required = [
            'use-api.ts',
            'use-controls.ts',
            'use-policies.ts',
            'use-tasks.ts',
            'use-assets.ts',
            'use-evidence.ts',
            'index.ts',
        ];
        for (const file of required) {
            expect(fs.existsSync(path.join(hooksDir, file))).toBe(true);
        }
    });
});
