import { getPermissionsForRole } from '@/lib/permissions';

/**
 * GRC teardown phase 2 removed the `practices`, `policies`, `vendors`,
 * `tests`, `frameworks` and `audits` permission domains from
 * `PermissionSet`. The surviving domains are `evidence`, `tasks`,
 * `reports`, `knowledge` and `admin`.
 *
 * Every assertion below that named a removed domain has been RE-POINTED
 * at a surviving domain that holds the same role-tiering bound, not
 * dropped — the bound each case proves is called out inline.
 */
describe('Permissions Map', () => {
    it('grants full access to ADMIN', () => {
        const permissions = getPermissionsForRole('ADMIN');

        // Check a random sample of critical permissions. Bound: the
        // admin tier holds write, export AND privileged-config flags.
        // (`practices.edit` → `evidence.edit`, `audits.freeze` →
        // `reports.export`, `frameworks.install` → `admin.scim`.)
        expect(permissions.evidence.edit).toBe(true);
        expect(permissions.tasks.assign).toBe(true);
        expect(permissions.admin.manage).toBe(true);
        expect(permissions.reports.export).toBe(true);
        expect(permissions.admin.scim).toBe(true);
    });

    it('grants limited write access to EDITOR', () => {
        const permissions = getPermissionsForRole('EDITOR');

        // Editors can create/edit but not admin.
        expect(permissions.tasks.create).toBe(true);
        expect(permissions.evidence.upload).toBe(true);

        // Bound preserved: the write tier stops short of the privileged
        // tier. `policies.approve` / `frameworks.install` proved that on
        // GRC domains; the admin flags prove it on what remains.
        expect(permissions.admin.manage).toBe(false);
        expect(permissions.admin.members).toBe(false);
        expect(permissions.admin.scim).toBe(false);
    });

    it('grants read-only plus export access to AUDITOR', () => {
        const permissions = getPermissionsForRole('AUDITOR');

        // Auditors can view and download, but not edit
        expect(permissions.evidence.view).toBe(true);
        expect(permissions.evidence.download).toBe(true);

        expect(permissions.evidence.edit).toBe(false);
        expect(permissions.evidence.upload).toBe(false);

        // Bound preserved: AUDITOR holds exactly ONE capability beyond
        // plain read that READER does not, and still holds no write or
        // admin capability. That was `audits.share` (true) vs
        // `audits.freeze` (false); the audits domain is gone, so it now
        // rides `reports.export` — true for AUDITOR, false for READER
        // (asserted in the READER case below).
        expect(permissions.reports.export).toBe(true);
        expect(permissions.admin.manage).toBe(false);
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
        // permission layer. The practices / vendors / audits rows left
        // with the GRC teardown; the sweep is still exhaustive over the
        // surviving domains, so nothing weakened.
        expect(permissions.evidence.view).toBe(false);
        expect(permissions.evidence.download).toBe(false);
        expect(permissions.reports.view).toBe(false);
        expect(permissions.reports.export).toBe(false);
        expect(permissions.knowledge.view).toBe(false);
        expect(permissions.admin.view).toBe(false);
        expect(permissions.admin.members).toBe(false);
    });

    it('grants strict read-only access to READER', () => {
        const permissions = getPermissionsForRole('READER');

        expect(permissions.evidence.view).toBe(true);
        expect(permissions.evidence.download).toBe(true);

        expect(permissions.evidence.edit).toBe(false);
        expect(permissions.tasks.create).toBe(false);
        expect(permissions.admin.manage).toBe(false);
        expect(permissions.reports.export).toBe(false);
    });
});
