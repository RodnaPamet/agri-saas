/**
 * RSC Regression Guard
 *
 * Ensures read-heavy pages that were converted to React Server Components
 * do not regress back to client components.
 *
 * Tests:
 * 1. RSC pages must NOT contain 'use client' in their page.tsx
 * 2. RSC pages must NOT contain useEffect + fetch patterns for initial data
 * 3. RSC pages should have a loading.tsx skeleton
 *
 * To add a new RSC page, add its path (relative to the tenant app dir) to RSC_PAGES.
 *
 * RUN: npx jest tests/unit/rsc-regression.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const TENANT_APP_DIR = path.resolve(__dirname, '../../src/app/t/[tenantSlug]/(app)');

/**
 * Pages that MUST remain server components.
 * Each entry is a directory name under /t/[tenantSlug]/(app)/.
 */
const RSC_PAGES = [
    'dashboard',
    'clauses',
    'evidence',
];

function readPageFile(pageName: string): string | null {
    const filePath = path.join(TENANT_APP_DIR, pageName, 'page.tsx');
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
}

describe('RSC Regression Guard', () => {
    // ─── 1. No 'use client' in RSC pages ───
    describe('RSC pages must not contain "use client"', () => {
        for (const pageName of RSC_PAGES) {
            it(`${pageName}/page.tsx must NOT have 'use client'`, () => {
                const content = readPageFile(pageName);
                expect(content).not.toBeNull();
                if (content) {
                    // Check for 'use client' directive (typically at the top of the file)
                    const hasUseClient = /^\s*['"]use client['"]/m.test(content);
                    expect(hasUseClient).toBe(false);
                }
            });
        }
    });

    // ─── 2. No useEffect + fetch patterns in RSC pages ───
    describe('RSC pages must not use useEffect + fetch for data loading', () => {
        for (const pageName of RSC_PAGES) {
            it(`${pageName}/page.tsx must NOT use useEffect`, () => {
                const content = readPageFile(pageName);
                expect(content).not.toBeNull();
                if (content) {
                    const hasUseEffect = content.includes('useEffect');
                    expect(hasUseEffect).toBe(false);
                }
            });

            it(`${pageName}/page.tsx must NOT fetch internal API`, () => {
                const content = readPageFile(pageName);
                expect(content).not.toBeNull();
                if (content) {
                    // Flag fetch('/api/...) patterns — RSC should call usecases directly
                    const hasFetchApi = /fetch\s*\(\s*[`'"]\/?api\//.test(content);
                    expect(hasFetchApi).toBe(false);
                }
            });
        }
    });

    // ─── 3. RSC pages should have loading.tsx ───
    describe('RSC pages should have a loading.tsx skeleton', () => {
        for (const pageName of RSC_PAGES) {
            it(`${pageName}/ should have a loading.tsx`, () => {
                const loadingPath = path.join(TENANT_APP_DIR, pageName, 'loading.tsx');
                expect(fs.existsSync(loadingPath)).toBe(true);
            });
        }
    });

    // ─── 4. RSC pages should use server-side translations ───
    describe('RSC pages should use getTranslations (not useTranslations)', () => {
        for (const pageName of RSC_PAGES) {
            it(`${pageName}/page.tsx must NOT import useTranslations`, () => {
                const content = readPageFile(pageName);
                expect(content).not.toBeNull();
                if (content) {
                    const hasUseTranslations = content.includes('useTranslations');
                    expect(hasUseTranslations).toBe(false);
                }
            });
        }
    });

    // ─── 5. Client islands in RSC pages should NOT duplicate data fetching ───
    describe('Client islands must not useEffect-fetch for initial data', () => {
        for (const pageName of RSC_PAGES) {
            const pageDir = path.join(TENANT_APP_DIR, pageName);
            if (!fs.existsSync(pageDir)) continue;

            const clientFiles = fs.readdirSync(pageDir)
                .filter((f) => f.endsWith('.tsx') && f !== 'page.tsx' && f !== 'loading.tsx');

            for (const clientFile of clientFiles) {
                it(`${pageName}/${clientFile} must NOT useEffect + fetch('/api/') for initial load`, () => {
                    const content = fs.readFileSync(path.join(pageDir, clientFile), 'utf8');
                    const lines = content.split('\n');

                    // Check for useEffect that contains a fetch to /api/
                    // This catches patterns like useEffect(() => { fetch('/api/...')
                    let inUseEffect = false;
                    const violations: string[] = [];

                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i].trim();
                        if (line.includes('useEffect')) inUseEffect = true;
                        if (inUseEffect && /fetch\s*\(\s*[`'"]\/?api\//.test(line)) {
                            violations.push(`Line ${i + 1}: ${line}`);
                        }
                        // Reset after closing the useEffect (simple heuristic)
                        if (inUseEffect && line === '}, []);') inUseEffect = false;
                        if (inUseEffect && line === '}, [])') inUseEffect = false;
                    }

                    expect(violations).toEqual([]);
                });
            }
        }
    });
});
