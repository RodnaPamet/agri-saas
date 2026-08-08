/**
 * Guardrail tests: prevent "Loading..." text regressions and ensure
 * key routes have loading.tsx skeleton files.
 *
 * These tests run as part of the Jest suite (node env, no DOM needed).
 * They scan the filesystem, so they are fast and framework-agnostic.
 */
import * as fs from 'fs';
import * as path from 'path';

const TENANT_ROUTES_DIR = path.resolve(__dirname, '../../src/app/t/[tenantSlug]/(app)');

/**
 * Recursively find all .tsx files under a directory.
 */
function findTsxFiles(dir: string, acc: string[] = []): string[] {
    if (!fs.existsSync(dir)) return acc;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) findTsxFiles(full, acc);
        else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) acc.push(full);
    }
    return acc;
}

describe('Loading-state guardrails', () => {
    // ─── 1. No "Loading..." literal text in page components ───
    describe('No bare "Loading..." text in tenant route pages', () => {
        const files = findTsxFiles(TENANT_ROUTES_DIR);

        // Allowed patterns: inline mutation states like "Uploading...", "Saving...", "Applying..."
        // Also allow loading.tsx files themselves (they're the solution, not the problem)
        const ALLOWED_PATTERNS = [
            /Uploading\.\.\./,
            /Saving\.\.\./,
            /Applying\.\.\./,
            /Posting\.\.\./,
            /Linking\.\.\./,
            /Assigning\.\.\./,
            /Deleting\.\.\./,
            /Creating\.\.\./,
            /Exporting\.\.\./,
            /Generating\.\.\./,
            /Sharing\.\.\./,
        ];

        const PAGE_FILES = files.filter(f => {
            const basename = path.basename(f);
            // Skip loading.tsx files — those ARE the skeleton files
            if (basename === 'loading.tsx') return false;
            // Only check page.tsx and client component files
            return basename === 'page.tsx' || basename.endsWith('Client.tsx');
        });

        it.each(PAGE_FILES)('should not contain bare "Loading..." or "Loading…" in %s', (filePath) => {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                // Check for "Loading..." or "Loading…" (ellipsis char)
                if (line.match(/Loading\.\.\./i) || line.match(/Loading…/i)) {
                    // Check if it's an allowed mutation pattern
                    const isAllowed = ALLOWED_PATTERNS.some(p => p.test(line));
                    if (!isAllowed) {
                        throw new Error(
                            `Found bare "Loading..." text at ${path.relative(TENANT_ROUTES_DIR, filePath)}:${i + 1}\n` +
                            `  Line: ${line.trim()}\n` +
                            `  Replace with a skeleton component from @/components/ui/skeleton`
                        );
                    }
                }
            }
        });
    });

    // ─── 2. Key routes must have loading.tsx ───
    describe('Key routes have loading.tsx', () => {
        const REQUIRED_ROUTES = [
            'controls',
            'evidence',
            'policies',
            'audits',
            'vendors',
            'dashboard',
            'issues',
            'assets',
        ];

        it.each(REQUIRED_ROUTES)('%s route has loading.tsx', (route) => {
            const loadingPath = path.join(TENANT_ROUTES_DIR, route, 'loading.tsx');
            expect(fs.existsSync(loadingPath)).toBe(true);
        });
    });
});
