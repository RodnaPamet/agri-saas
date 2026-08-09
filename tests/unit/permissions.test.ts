import { getPermissionsForRole } from '@/lib/permissions';

describe('Permissions Map', () => {
    it('grants full access to ADMIN', () => {
        const permissions = getPermissionsForRole('ADMIN');

        // Check a random sample of critical permissions
        expect(permissions.controls.edit).toBe(true);
        expect(permissions.policies.approve).toBe(true);
        expect(permissions.admin.manage).toBe(true);
        expect(permissions.audits.freeze).toBe(true);
        expect(permissions.frameworks.install).toBe(true);
    });

    it('grants limited write access to EDITOR', () => {
        const permissions = getPermissionsForRole('EDITOR');

        // Editors can create/edit but not approve/admin
        expect(permissions.controls.edit).toBe(true);
        expect(permissions.evidence.upload).toBe(true);

        expect(permissions.policies.approve).toBe(false);
        expect(permissions.admin.manage).toBe(false);
        expect(permissions.frameworks.install).toBe(false);
    });

    it('grants read-only and specific audit access to AUDITOR', () => {
        const permissions = getPermissionsForRole('AUDITOR');

        // Auditors can view and download, but not edit
        expect(permissions.controls.view).toBe(true);
        expect(permissions.evidence.download).toBe(true);

        expect(permissions.controls.edit).toBe(false);
        expect(permissions.evidence.upload).toBe(false);

        // Auditors can share audits
        expect(permissions.audits.share).toBe(true);
        expect(permissions.audits.freeze).toBe(false);
    });

    it('grants ONLY task access to MECHANISATOR (everything else hidden)', () => {
        const permissions = getPermissionsForRole('MECHANISATOR');
        // Tasks visible + editable (completion affordances render).
        expect(permissions.tasks.view).toBe(true);
        expect(permissions.tasks.edit).toBe(true);
        expect(permissions.tasks.create).toBe(false);
        expect(permissions.tasks.assign).toBe(false);
        // Every other domain is fully hidden — the opposite of READER's
        // "view everything". This is the load-bearing lockdown at the UI
        // permission layer.
        expect(permissions.controls.view).toBe(false);
        expect(permissions.evidence.view).toBe(false);
        expect(permissions.evidence.download).toBe(false);
        expect(permissions.vendors.view).toBe(false);
        expect(permissions.audits.view).toBe(false);
        expect(permissions.reports.view).toBe(false);
        expect(permissions.admin.view).toBe(false);
        expect(permissions.admin.members).toBe(false);
    });

    it('grants strict read-only access to READER', () => {
        const permissions = getPermissionsForRole('READER');

        expect(permissions.controls.view).toBe(true);
        expect(permissions.evidence.download).toBe(true);

        expect(permissions.controls.edit).toBe(false);
        expect(permissions.policies.approve).toBe(false);
        expect(permissions.admin.manage).toBe(false);
        expect(permissions.reports.export).toBe(false);
    });
});
