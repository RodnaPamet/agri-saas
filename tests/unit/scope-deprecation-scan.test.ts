/**
 * Scope Deprecation Scan — Report-Only Test
 *
 * Scans the src/ directory for remaining scope references to track migration progress.
 * Does NOT fail — just reports. Will be promoted to fail in Phase 2.
 */

import * as fs from 'fs';
import * as path from 'path';

import { blankNonCode } from '../helpers/blank-non-code';

const SRC_DIR = path.resolve(__dirname, '../../src');

/** Patterns that indicate scope-related code that needs migration. */
const SCOPE_PATTERNS = [
    { name: 'scopeId field', pattern: /scopeId/g },
    { name: 'scopeSlug param', pattern: /scopeSlug/g },
    { name: 'useScopeContext hook', pattern: /useScopeContext/g },
    { name: 'useScopeHref hook', pattern: /useScopeHref/g },
    { name: 'useScopeApiUrl hook', pattern: /useScopeApiUrl/g },
    { name: 'ScopeProvider component', pattern: /ScopeProvider/g },
    { name: 'ScopeMembership model', pattern: /ScopeMembership/g },
    { name: 'resolveScopeContext call', pattern: /resolveScopeContext/g },
    { name: 'getScopeCtx call', pattern: /getScopeCtx/g },
    { name: 'executeInScope call', pattern: /executeInScope/g },
    { name: 'defaultScopeSlug field', pattern: /defaultScopeSlug/g },
    { name: 'hasScopeRole call', pattern: /hasScopeRole/g },
    { name: '/s/[scopeSlug] route', pattern: /\/s\/\[scopeSlug\]/g },
    { name: 'app.scope_id RLS', pattern: /app\.scope_id/g },
    { name: 'runInScopeContext call', pattern: /runInScopeContext/g },
    { name: 'withTenantScopeDb call', pattern: /withTenantScopeDb/g },
];

/** Files to exclude from scanning (test files, this file itself, generated) */
const EXCLUDE_DIRS = ['node_modules', '.next', 'dist'];
const INCLUDE_EXTENSIONS = ['.ts', '.tsx'];

function walk(dir: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (EXCLUDE_DIRS.includes(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...walk(fullPath));
        } else if (INCLUDE_EXTENSIONS.some(ext => entry.name.endsWith(ext))) {
            results.push(fullPath);
        }
    }
    return results;
}

interface ScanResult {
    pattern: string;
    count: number;
    files: { file: string; lineNumbers: number[] }[];
}

function scanForPattern(files: string[], patternName: string, regex: RegExp): ScanResult {
    const result: ScanResult = { pattern: patternName, count: 0, files: [] };

    for (const file of files) {
        // Comments blanked (#1774). Safe to do even though this reports LINE
        // NUMBERS: `blankNonCode` replaces each blanked character with a space
        // and leaves every newline, so offsets and line numbers are identical
        // to the input. That property is documented and load-bearing here —
        // a transform that shortened lines would make every reported number
        // point somewhere else.
        const content = blankNonCode(fs.readFileSync(file, 'utf-8'));
        const lines = content.split('\n');
        const lineNumbers: number[] = [];

        for (let i = 0; i < lines.length; i++) {
            // Reset regex state for each line
            const lineRegex = new RegExp(regex.source, regex.flags);
            if (lineRegex.test(lines[i])) {
                lineNumbers.push(i + 1);
            }
        }

        if (lineNumbers.length > 0) {
            const relPath = path.relative(SRC_DIR, file).replace(/\\/g, '/');
            result.count += lineNumbers.length;
            result.files.push({ file: relPath, lineNumbers });
        }
    }

    return result;
}

describe('Scope Deprecation Scan (report-only)', () => {
    const files = walk(SRC_DIR);

    it('reports remaining scope references across the codebase', () => {
        const results: ScanResult[] = [];
        let totalRefs = 0;

        for (const { name, pattern } of SCOPE_PATTERNS) {
            const result = scanForPattern(files, name, pattern);
            if (result.count > 0) {
                results.push(result);
                totalRefs += result.count;
            }
        }

        // Print summary table
        console.log('\n╔══════════════════════════════════════════════════╗');
        console.log('║     SCOPE DEPRECATION SCAN — REMAINING REFS     ║');
        console.log('╠══════════════════════════════════════════════════╣');

        if (results.length === 0) {
            console.log('║  🎉 No scope references found! Migration done.  ║');
        } else {
            for (const r of results) {
                console.log(`║  ${r.pattern.padEnd(35)} ${String(r.count).padStart(4)} refs ║`);
                for (const f of r.files) {
                    console.log(`║    └─ ${f.file.substring(0, 38).padEnd(38)} L${f.lineNumbers.join(',').substring(0, 5)} ║`);
                }
            }
        }

        console.log('╠══════════════════════════════════════════════════╣');
        console.log(`║  Total: ${String(totalRefs).padStart(4)} references in ${String(results.length).padStart(2)} categories     ║`);
        console.log(`║  Files scanned: ${String(files.length).padStart(4)}                          ║`);
        console.log('╚══════════════════════════════════════════════════╝\n');

        // This test DOES NOT FAIL — it only reports.
        // Phase 2 will promote this to expect(totalRefs).toBe(0).
        expect(true).toBe(true);
    });
});
