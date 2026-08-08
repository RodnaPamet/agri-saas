/**
 * RBAC Guardrail Scan Tests
 *
 * These tests statically scan critical source files to ensure RBAC enforcement
 * patterns are present and haven't regressed. They don't test runtime behavior —
 * they verify that the right permission checks exist in the right files.
 *
 * If a test fails, it means someone removed or bypassed a required RBAC guard.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../../src');

function readFile(relativePath: string): string {
    const fullPath = path.join(SRC, relativePath);
    if (!fs.existsSync(fullPath)) {
        throw new Error(`Expected file not found: ${fullPath}`);
    }
    return fs.readFileSync(fullPath, 'utf-8');
}

describe('RBAC Guardrail Scans', () => {
    describe('Admin route guards', () => {
        test('admin layout guard exists and uses RequirePermission', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/admin/layout.tsx');
            // Centralized layout guard must use RequirePermission with admin resource
            expect(content).toMatch(/RequirePermission/);
            expect(content).toMatch(/resource="admin"/);
            // Must render ForbiddenPage for unauthorized access
            expect(content).toMatch(/ForbiddenPage/);
        });

        test('admin/rbac page does NOT have redundant per-page guard (uses layout)', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/admin/rbac/page.tsx');
            // Should NOT contain per-page guard — layout handles authorization
            expect(content).not.toMatch(/ServerForbiddenPage/);
            expect(content).not.toMatch(/RequirePermission/);
        });
    });

    describe('Controls page RBAC', () => {
        test('controls server page resolves appPerms and passes to client island', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/controls/page.tsx');
            // Server component must resolve permissions via ctx.appPermissions (from custom role resolution)
            expect(content).toMatch(/ctx\.appPermissions\.controls/);
            // Must pass appPermissions (including controls) to client island
            expect(content).toMatch(/appPermissions/);
        });

        test('controls client island receives and enforces create/edit permissions', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx');
            // Client island must declare create and edit permission props
            expect(content).toMatch(/create.*boolean/);
            expect(content).toMatch(/edit.*boolean/);
        });
    });

    describe('Audit pack RBAC', () => {
        test('freeze button is wrapped in RequirePermission', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/audits/packs/[packId]/page.tsx');
            expect(content).toMatch(/RequirePermission/);
            expect(content).toMatch(/resource="audits" action="freeze"/);
        });

        test('share button is wrapped in RequirePermission', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/audits/packs/[packId]/page.tsx');
            expect(content).toMatch(/resource="audits" action="share"/);
        });

        test('clone button is wrapped in RequirePermission', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/audits/packs/[packId]/page.tsx');
            expect(content).toMatch(/resource="audits" action="manage"/);
        });
    });

    describe('Policies page RBAC', () => {
        test('policies server page resolves permissions and passes to client island', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/policies/page.tsx');
            // Server component must resolve tenant context (which includes permissions)
            expect(content).toMatch(/getTenantCtx/);
            // Must pass permissions to client island
            expect(content).toMatch(/permissions/);
        });
    });

    describe('Farm tasks page RBAC', () => {
        // The compliance /tasks list was retired; /farm-tasks is the sole task
        // UI. Its create affordance + bulk selection gate on write permission
        // (permissions.canWrite from the tenant context).
        test('farm-tasks create + bulk actions gate on write permission', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/farm-tasks/FarmTasksClient.tsx');
            expect(content).toMatch(/canWrite/);
        });
    });

    describe('Vendors page RBAC', () => {
        test('vendor create button uses appPerms', () => {
            const content = readFile('app/t/[tenantSlug]/(app)/vendors/page.tsx');
            expect(content).toMatch(/appPermissions\.vendors\.create/);
        });
    });



    describe('Navigation RBAC', () => {
        test('SidebarNav filters hidden items by permission', () => {
            const content = readFile('components/layout/SidebarNav.tsx');
            expect(content).toMatch(/usePermissions/);
            // Nav items are gated by `visible:` flags derived from the
            // tenant's permitted modules (certAvailable / grainAvailable),
            // and the admin section is gated by a `perms.<area>.<action>`
            // permission path. Both mechanisms must remain present so the
            // sidebar never renders wide-open.
            expect(content).toMatch(/visible:\s*\w*Available/);
            expect(content).toMatch(/perms\.\w+\.\w+/);
            expect(content).toMatch(/\.filter\(/);
        });
    });

    describe('Core permission infrastructure', () => {
        test('RequirePermission component exists and uses usePermissions', () => {
            const content = readFile('components/require-permission.tsx');
            expect(content).toMatch(/usePermissions/);
            expect(content).toMatch(/hasPermission/);
        });

        test('PermissionSet type covers all critical resources', () => {
            const content = readFile('lib/permissions.ts');
            const requiredResources = ['controls', 'evidence', 'policies', 'tasks', 'vendors', 'tests', 'frameworks', 'audits', 'reports', 'admin'];
            for (const resource of requiredResources) {
                expect(content).toContain(`${resource}:`);
            }
        });

        test('TenantProvider passes appPermissions', () => {
            const content = readFile('app/t/[tenantSlug]/layout.tsx');
            expect(content).toMatch(/appPermissions/);
        });
    });
});
