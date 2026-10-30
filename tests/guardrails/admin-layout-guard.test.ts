/**
 * Guardrail test: Admin layout guard existence.
 *
 * Ensures the centralized admin layout guard exists and contains
 * the RequirePermission wrapper. If this file is deleted or the
 * guard is removed, admin pages lose their authorization boundary.
 */
import * as fs from 'fs';
import * as path from 'path';

const ADMIN_LAYOUT_PATH = path.resolve(
    __dirname,
    '../../src/app/t/[tenantSlug]/(app)/admin/layout.tsx'
);

describe('Admin layout guard', () => {
    test('admin layout.tsx exists', () => {
        expect(fs.existsSync(ADMIN_LAYOUT_PATH)).toBe(true);
    });

    test('admin layout imports RequirePermission', () => {
        const content = fs.readFileSync(ADMIN_LAYOUT_PATH, 'utf-8');
        expect(content).toContain('RequirePermission');
    });

    test('admin layout imports ForbiddenPage', () => {
        const content = fs.readFileSync(ADMIN_LAYOUT_PATH, 'utf-8');
        expect(content).toContain('ForbiddenPage');
    });

    test('admin layout checks admin resource permission', () => {
        const content = fs.readFileSync(ADMIN_LAYOUT_PATH, 'utf-8');
        expect(content).toContain('resource="admin"');
    });
});

/**
 * Guardrail: No admin page should have its own redundant RequirePermission
 * for the "admin" resource. The layout handles this centrally.
 *
 * Pages that need finer-grained checks (e.g. admin.manage vs admin.view)
 * should be explicitly allowlisted below.
 */
describe('No duplicate admin guards on pages', () => {
    const ADMIN_PAGES_DIR = path.resolve(
        __dirname,
        '../../src/app/t/[tenantSlug]/(app)/admin'
    );

    // Allowlist: files that may import RequirePermission for non-redundant reasons
    const ALLOWLIST = new Set([
        'layout.tsx', // The layout itself — obviously needs it
    ]);

    function findPageFiles(dir: string): string[] {
        const files: string[] = [];
        if (!fs.existsSync(dir)) {
            throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
        }

        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                files.push(...findPageFiles(fullPath));
            } else if (entry.name === 'page.tsx') {
                files.push(fullPath);
            }
        }
        return files;
    }

    /**
     * The denominator, hoisted so both assertions below range over the SAME
     * measured population — and so the selector has teeth.
     *
     * Both tests derive `violations` from these pages and assert it is empty,
     * which an EMPTY page list satisfies for free. `selector-teeth` reported
     * `findPageFiles()` as a dead selector for exactly that reason: mutating it
     * to return nothing left the guard green, so nothing here was checking that
     * any admin page had been read at all.
     *
     * Measured 2026-10-30 at 21 `page.tsx` files under this tree. The floor
     * sits below that so adding or removing a page does not move it, and well
     * above zero so an emptied walk fails instead of passing.
     */
    const PAGES = findPageFiles(ADMIN_PAGES_DIR);
    const PAGE_FLOOR = 15;

    test('[admin-layout-guard] ranges over a real set of admin pages', () => {
        console.log(
            `[admin-layout-guard] ${PAGES.length} page.tsx under the tenant admin tree, `
                + `${ALLOWLIST.size} allowlisted`,
        );
        expect(PAGES.length).toBeGreaterThanOrEqual(PAGE_FLOOR);
    });

    test('no admin page.tsx files import RequirePermission for admin resource', () => {
        const violations: string[] = [];

        for (const pagePath of PAGES) {
            const basename = path.basename(pagePath);
            if (ALLOWLIST.has(basename)) continue;

            const content = fs.readFileSync(pagePath, 'utf-8');
            // Check for RequirePermission import (not just any mention in comments)
            if (
                content.includes("from '@/components/require-permission'") ||
                content.includes('from "@/components/require-permission"')
            ) {
                const relPath = path.relative(ADMIN_PAGES_DIR, pagePath);
                violations.push(relPath);
            }
        }

        expect(violations).toEqual([]);
    });

    test('no admin page.tsx files import ServerForbiddenPage', () => {
        const violations: string[] = [];

        for (const pagePath of PAGES) {
            const content = fs.readFileSync(pagePath, 'utf-8');
            if (
                content.includes("from '@/components/ForbiddenPage'") ||
                content.includes('from "@/components/ForbiddenPage"')
            ) {
                const relPath = path.relative(ADMIN_PAGES_DIR, pagePath);
                violations.push(relPath);
            }
        }

        expect(violations).toEqual([]);
    });
});
