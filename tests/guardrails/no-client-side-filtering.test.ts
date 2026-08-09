/**
 * GUARDRAIL: Detect client-side filtering & stacked filter anti-patterns.
 *
 * 1) Scans list page client components for patterns that suggest data is
 *    fetched server-side and then re-filtered on the client (e.g.,
 *    `.filter(` after `useQuery`).
 *
 * 2) Detects stacked full-width `<select>` or `<input>` filter elements,
 *    which indicates someone reverted to the pre-Epic 53 filter pattern
 *    instead of using the shared `FilterToolbar`.
 *
 * 3) Every migrated list page must import `FilterToolbar` from the
 *    canonical path.
 *
 * This is a heuristic — it flags suspicious patterns, not guaranteed bugs.
 */
import fs from 'fs';
import path from 'path';

// Root of the monorepo (this file lives at tests/guardrails/...).
const root = path.resolve(__dirname, '../..');

// List page client components that own server-side filter state and must
// render `<FilterToolbar>`. The page.tsx server wrappers hydrate these.
const LIST_CLIENT_FILES = [
    'src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx',
    'src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx',
    'src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx',
    'src/app/t/[tenantSlug]/(app)/policies/PoliciesClient.tsx',
    'src/app/t/[tenantSlug]/(app)/vendors/VendorsClient.tsx',
];

/** Patterns that suggest client-side filtering of server data. */
const CLIENT_FILTER_PATTERNS = [
    /\.(filter|sort)\s*\(\s*(item|row|r|c|v|p|t|e|a)\s*=>/,
    /data\.(filter|sort)\s*\(/,
    /items\.(filter|sort)\s*\(/,
    /\.filter\(\s*\(/,
];

/** Patterns that indicate stacked/legacy filter UI (not FilterToolbar). */
const STACKED_FILTER_PATTERNS = [
    // Multiple native <select> elements with "input" class in filter sections.
    /<select\s+className="input\s+w-/,
    // Full-width search input with onChange={…setFilter} (pre-Epic 53 pattern).
    /onChange=\{e\s*=>\s*setFilter\('q'/,
];

function readFile(relPath: string): string | null {
    const absPath = path.join(root, relPath);
    if (!fs.existsSync(absPath)) return null;
    return fs.readFileSync(absPath, 'utf-8');
}

function scanForPatterns(content: string, patterns: RegExp[]): string[] {
    const lines = content.split('\n');
    const flagged: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip comment lines.
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
        // Skip imports/types.
        if (line.trim().startsWith('import ') || line.trim().startsWith('type ') || line.trim().startsWith('interface ')) continue;
        // Honor the `// guardrail-ignore` directive on the previous
        // non-blank line — local aggregation over already-loaded rows
        // (KPI counts, heatmap bucketing) is not client-side refilter.
        let prevIdx = i - 1;
        while (prevIdx >= 0 && lines[prevIdx].trim() === '') prevIdx--;
        const prev = prevIdx >= 0 ? lines[prevIdx].trim() : '';
        if (prev.startsWith('// guardrail-ignore')) continue;

        for (const pattern of patterns) {
            if (pattern.test(line)) {
                flagged.push(`  Line ${i + 1}: ${line.trim()}`);
            }
        }
    }
    return flagged;
}

describe('Guardrail: No client-side filtering in list pages', () => {
    for (const relPath of LIST_CLIENT_FILES) {
        it(`${path.basename(relPath, '.tsx')} should not .filter() server data on client`, () => {
            const content = readFile(relPath);
            expect(content).not.toBeNull();
            if (!content) return;

            const flagged = scanForPatterns(content, CLIENT_FILTER_PATTERNS);

            if (flagged.length > 0) {
                throw new Error(
                    `Client-side filtering detected in ${relPath}:\n${flagged.join('\n')}\n` +
                        'All filtering must be server-side via URL params. ' +
                        'If this is intentional local sub-filtering of a small array, ' +
                        'add a // guardrail-ignore comment above the line.',
                );
            }
        });
    }
});

describe('Guardrail: No stacked/legacy filter UI', () => {
    for (const relPath of LIST_CLIENT_FILES) {
        it(`${path.basename(relPath, '.tsx')} should use FilterToolbar, not stacked selects`, () => {
            const content = readFile(relPath);
            expect(content).not.toBeNull();
            if (!content) return;

            const flagged = scanForPatterns(content, STACKED_FILTER_PATTERNS);

            if (flagged.length > 0) {
                throw new Error(
                    `Legacy stacked filter UI detected in ${relPath}:\n${flagged.join('\n')}\n` +
                        'Use <FilterToolbar> from `@/components/filters/FilterToolbar` instead of inline <select>/<input> elements. ' +
                        'See docs/filters.md for the standard pattern.',
                );
            }
        });
    }
});

describe('Guardrail: All list pages import FilterToolbar', () => {
    // `EntityListPage` is the composition shell that internally renders
    // `<FilterToolbar>` (see `src/components/layout/EntityListPage.tsx`).
    // A page that uses the shell satisfies this guardrail without
    // importing FilterToolbar directly — that's the whole point of the
    // shell. Either signal counts.
    for (const relPath of LIST_CLIENT_FILES) {
        it(`${path.basename(relPath, '.tsx')} should import FilterToolbar (or EntityListPage)`, () => {
            const content = readFile(relPath);
            expect(content).not.toBeNull();
            if (!content) return;

            const usesFilterToolbar = content.includes('FilterToolbar');
            const usesEntityListPage = content.includes('EntityListPage');
            expect(usesFilterToolbar || usesEntityListPage).toBe(true);
        });
    }
});
