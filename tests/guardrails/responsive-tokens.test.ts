/**
 * Guardrail: responsive token usage.
 *
 * Scans page files to catch responsive anti-patterns that cause
 * mobile overflow or layout issues:
 *
 *  - Unguarded large fixed widths (e.g. `w-72` without `sm:w-72` on the same className)
 *
 * Runs as part of the Jest suite — no DOM needed.
 *
 * Files that haven't been made responsive yet are in the KNOWN_EXCEPTIONS list.
 * As files are refactored they should be removed from exceptions.
 */
import * as fs from 'fs';
import * as path from 'path';

const TENANT_ROUTES_DIR = path.resolve(__dirname, '../../src/app/t/[tenantSlug]/(app)');

function findPageFiles(dir: string, acc: string[] = []): string[] {
    if (!fs.existsSync(dir)) return acc;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) findPageFiles(full, acc);
        else if (entry.name === 'page.tsx' || entry.name.endsWith('Client.tsx') || entry.name.endsWith('Browser.tsx')) {
            acc.push(full);
        }
    }
    return acc;
}

/**
 * Pages that haven't been refactored to responsive yet.
 * Remove from this list as pages are made responsive.
 */
const KNOWN_EXCEPTIONS = new Set([
    'controls/[controlId]/page.tsx',
    'evidence/EvidenceClient.tsx',
    'policies/templates/page.tsx',
    'policies/[policyId]/page.tsx',
    'risks/new/page.tsx',
    'risks/[riskId]/page.tsx',
    'farm-tasks/[taskId]/FarmTaskDetailClient.tsx',
    'vendors/[vendorId]/page.tsx',
]);

describe('Responsive token guardrails', () => {
    const allPageFiles = findPageFiles(TENANT_ROUTES_DIR);

    // Filter out known exceptions
    const pageFiles = allPageFiles.filter(f => {
        const rel = path.relative(TENANT_ROUTES_DIR, f).replace(/\\/g, '/');
        return !KNOWN_EXCEPTIONS.has(rel);
    });

    describe('No unguarded large fixed widths', () => {
        // Match w-{number} where number >= 28
        const LARGE_FIXED_WIDTH_RE = /\bw-(28|32|36|40|44|48|52|56|60|64|72|80|96)\b/g;

        it.each(pageFiles)('no unguarded large fixed widths in %s', (filePath) => {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            const violations: string[] = [];

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line.trim().startsWith('//') || line.trim().startsWith('import') || line.trim().startsWith('*')) continue;

                const matches = [...line.matchAll(LARGE_FIXED_WIDTH_RE)];
                if (!matches.length) continue;

                for (const match of matches) {
                    const widthClass = match[0]; // e.g. "w-72"
                    const idx = match.index!;

                    // Check if this specific occurrence has a responsive prefix immediately before it
                    const before = line.substring(Math.max(0, idx - 4), idx);
                    if (/(?:sm|md|lg|xl):$/.test(before)) continue;

                    // Check if anywhere on the same className attribute there's a responsive-prefixed version
                    // Find the surrounding quotes (className="...")
                    const quoteStart = line.lastIndexOf('"', idx);
                    const backtickStart = line.lastIndexOf('`', idx);
                    const attrStart = Math.max(quoteStart, backtickStart);
                    const quoteEnd = line.indexOf('"', idx + widthClass.length);
                    const backtickEnd = line.indexOf('`', idx + widthClass.length);
                    const attrEnd = Math.min(
                        quoteEnd >= 0 ? quoteEnd : Infinity,
                        backtickEnd >= 0 ? backtickEnd : Infinity,
                    );

                    if (attrStart >= 0 && attrEnd < Infinity) {
                        const classStr = line.substring(attrStart, attrEnd + 1);
                        // If there's any responsive-prefixed width (sm:w-, md:w-, lg:w-) in the same class string,
                        // the fixed width is guarded (it's the mobile-first default)
                        if (/(?:sm|md|lg|xl|2xl):w-/.test(classStr)) continue;
                    }

                    violations.push(
                        `  Line ${i + 1}: "${widthClass}" — add responsive prefix (e.g., sm:${widthClass}) or use w-full sm:${widthClass}`
                    );
                }
            }

            expect(violations).toEqual([]);
        });
    });

    // Ensure known exceptions count is tracked — shrink over time
    it('known exceptions count is tracked (should decrease over time)', () => {
        expect(KNOWN_EXCEPTIONS.size).toBeLessThanOrEqual(12);
    });
});
