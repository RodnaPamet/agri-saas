import type { Role, OrgRole } from '@prisma/client';

export type PermissionSet = {
    controls: { view: boolean; create: boolean; edit: boolean };
    evidence: { view: boolean; upload: boolean; edit: boolean; download: boolean };
    policies: { view: boolean; create: boolean; edit: boolean; approve: boolean };
    tasks: { view: boolean; create: boolean; edit: boolean; assign: boolean };
    vendors: { view: boolean; create: boolean; edit: boolean };
    tests: { view: boolean; create: boolean; execute: boolean };
    frameworks: { view: boolean; install: boolean };
    audits: { view: boolean; manage: boolean; freeze: boolean; share: boolean };
    reports: { view: boolean; export: boolean };
    admin: {
        view: boolean;
        manage: boolean;
        members: boolean;
        sso: boolean;
        scim: boolean;
        /**
         * Tenant lifecycle operations: delete tenant, rotate DEK,
         * transfer ownership. OWNER-only by policy; ADMIN gets false.
         */
        tenant_lifecycle: boolean;
        /**
         * Invite / remove OWNERs, assign OWNER role. OWNER-only by
         * policy; ADMIN gets false (ADMIN can still invite ADMIN).
         */
        owner_management: boolean;
    };
};

/**
 * Permission keys that are OWNER-ONLY by policy and can NEVER be granted
 * through a custom role.
 *
 * `VALID_BASE_ROLES` in `custom-roles.ts` excludes OWNER, so no custom role can
 * legitimately need these — an OWNER cannot be expressed as a custom role in
 * the first place. Enforced in BOTH directions:
 *
 *   - `validatePermissionsJson` rejects them at write time, so the DB never
 *     stores an escalating blob;
 *   - `parsePermissionsJson` forces them false at read time, so any blob that
 *     predates this guard (or is written by a future code path that forgets)
 *     still resolves harmlessly.
 *
 * Without the read-time half, rows already in the database would keep their
 * escalation after a deploy.
 */
export const OWNER_ONLY_PERMISSIONS: ReadonlyArray<{ domain: keyof PermissionSet; action: string }> =
    [
        { domain: 'admin', action: 'tenant_lifecycle' },
        { domain: 'admin', action: 'owner_management' },
    ];

/**
 * Canonical list of all permission domain keys.
 *
 * EXPORTED because the custom-role editor renders its checkbox grid from it.
 * It previously kept a hand-copied duplicate that silently drifted — it was
 * missing `tenant_lifecycle` / `owner_management` for three months, which is
 * the only reason the escalation below was not one click away in the UI.
 */
export const PERMISSION_SCHEMA: Record<keyof PermissionSet, string[]> = {
    controls: ['view', 'create', 'edit'],
    evidence: ['view', 'upload', 'edit', 'download'],
    policies: ['view', 'create', 'edit', 'approve'],
    tasks: ['view', 'create', 'edit', 'assign'],
    vendors: ['view', 'create', 'edit'],
    tests: ['view', 'create', 'execute'],
    frameworks: ['view', 'install'],
    audits: ['view', 'manage', 'freeze', 'share'],
    reports: ['view', 'export'],
    admin: ['view', 'manage', 'members', 'sso', 'scim', 'tenant_lifecycle', 'owner_management'],
};

/**
 * Returns a static, granular UI PermissionSet for a given Role.
 * This ensures that client UI elements can rely on a consistent set of booleans
 * instead of manually checking `role === 'ADMIN' || role === 'EDITOR'`
 * which can lead to UI bugs and inconsistencies.
 * 
 * Note: Backend/API authorization must still independently verify permissions.
 */
export function getPermissionsForRole(role: Role): PermissionSet {
    switch (role) {
        case 'OWNER':
            // OWNER = ADMIN + tenant_lifecycle + owner_management.
            // Only role that can delete the tenant, rotate DEK, transfer
            // ownership, invite/remove other OWNERs, or assign OWNER role.
            return {
                controls: { view: true, create: true, edit: true },
                evidence: { view: true, upload: true, edit: true, download: true },
                policies: { view: true, create: true, edit: true, approve: true },
                tasks: { view: true, create: true, edit: true, assign: true },
                vendors: { view: true, create: true, edit: true },
                tests: { view: true, create: true, execute: true },
                frameworks: { view: true, install: true },
                audits: { view: true, manage: true, freeze: true, share: true },
                reports: { view: true, export: true },
                admin: {
                    view: true, manage: true, members: true, sso: true, scim: true,
                    tenant_lifecycle: true, owner_management: true,
                },
            };
        case 'ADMIN':
            return {
                controls: { view: true, create: true, edit: true },
                evidence: { view: true, upload: true, edit: true, download: true },
                policies: { view: true, create: true, edit: true, approve: true },
                tasks: { view: true, create: true, edit: true, assign: true },
                vendors: { view: true, create: true, edit: true },
                tests: { view: true, create: true, execute: true },
                frameworks: { view: true, install: true },
                audits: { view: true, manage: true, freeze: true, share: true },
                reports: { view: true, export: true },
                admin: {
                    view: true, manage: true, members: true, sso: true, scim: true,
                    // Explicit false: ADMIN is NOT the tenant owner.
                    // Delete / DEK rotation / OWNER management require OWNER role.
                    tenant_lifecycle: false, owner_management: false,
                },
            };
        case 'EDITOR':
            return {
                controls: { view: true, create: true, edit: true },
                evidence: { view: true, upload: true, edit: true, download: true },
                // Editors cannot approve policies usually, or maybe they can?
                // Aligning with standard EDITOR: can't approve or admin.
                policies: { view: true, create: true, edit: true, approve: false },
                tasks: { view: true, create: true, edit: true, assign: true },
                vendors: { view: true, create: true, edit: true },
                tests: { view: true, create: true, execute: true },
                frameworks: { view: true, install: false },
                audits: { view: true, manage: false, freeze: false, share: false },
                reports: { view: true, export: true },
                admin: { view: false, manage: false, members: false, sso: false, scim: false, tenant_lifecycle: false, owner_management: false },
            };
        case 'AUDITOR':
            return {
                controls: { view: true, create: false, edit: false },
                // Auditors can often download evidence but not upload/edit
                evidence: { view: true, upload: false, edit: false, download: true },
                policies: { view: true, create: false, edit: false, approve: false },
                // Auditors might be able to assign or comment on tasks, but typically read-only. We'll set read-only here.
                tasks: { view: true, create: false, edit: false, assign: false },
                vendors: { view: true, create: false, edit: false },
                tests: { view: true, create: false, execute: false },
                frameworks: { view: true, install: false },
                // Auditors can view and maybe export/share depending on policy, but let's keep view/share
                audits: { view: true, manage: false, freeze: false, share: true },
                reports: { view: true, export: true },
                admin: { view: false, manage: false, members: false, sso: false, scim: false, tenant_lifecycle: false, owner_management: false },
            };
        case 'MECHANISATOR':
            // Restricted machine-operator / sprayer persona. Sees ONLY the
            // "My work" screen (open assigned jobs) + the field-operation
            // completion flow; every other domain is hidden. Task VIEW +
            // EDIT are on so the completion affordances render; actual task
            // completion rides the assignee self-serve path (not general
            // write). Every other domain is fully false — the opposite of
            // the READER "view everything" default. NOTE: this explicit arm
            // is load-bearing — without it MECHANISATOR would fall through
            // to the READER default below and silently see every screen.
            return {
                controls: { view: false, create: false, edit: false },
                evidence: { view: false, upload: false, edit: false, download: false },
                policies: { view: false, create: false, edit: false, approve: false },
                tasks: { view: true, create: false, edit: true, assign: false },
                vendors: { view: false, create: false, edit: false },
                tests: { view: false, create: false, execute: false },
                frameworks: { view: false, install: false },
                audits: { view: false, manage: false, freeze: false, share: false },
                reports: { view: false, export: false },
                admin: { view: false, manage: false, members: false, sso: false, scim: false, tenant_lifecycle: false, owner_management: false },
            };
        case 'READER':
        default:
            return {
                controls: { view: true, create: false, edit: false },
                evidence: { view: true, upload: false, edit: false, download: true },
                policies: { view: true, create: false, edit: false, approve: false },
                tasks: { view: true, create: false, edit: false, assign: false },
                vendors: { view: true, create: false, edit: false },
                tests: { view: true, create: false, execute: false },
                frameworks: { view: true, install: false },
                audits: { view: true, manage: false, freeze: false, share: false },
                reports: { view: true, export: false },
                admin: { view: false, manage: false, members: false, sso: false, scim: false, tenant_lifecycle: false, owner_management: false },
            };
    }
}

// ─── Hub-and-spoke organization permissions (Epic O-2) ────────────────────
//
// Org-level permissions are deliberately KEPT SEPARATE from the tenant-
// level `PermissionSet` rather than nested inside it. The two govern
// different domains: tenant `PermissionSet` controls per-tenant
// resource access (controls, evidence, risks, etc.); `OrgPermissionSet`
// controls portfolio-level access (the org dashboard, tenant lifecycle
// under the org, org member management).
//
// They never mix: a request resolves EITHER `RequestContext` (tenant
// scope, via `getTenantCtx`) OR `OrgContext` (org scope, via
// `getOrgCtx`) — never both at the same time. The drill-down from
// portfolio → tenant detail re-resolves as `RequestContext` against
// the auto-provisioned AUDITOR membership, where the existing
// per-tenant permissions take over.

/**
 * Portfolio-level permissions for a hub-and-spoke organization.
 *
 *   - canViewPortfolio  — see the org dashboard summary cards
 *                         (snapshot aggregates across child tenants).
 *   - canDrillDown      — open per-tenant detail rows from the
 *                         portfolio. ORG_ADMIN only — relies on the
 *                         auto-provisioned AUDITOR `TenantMembership`
 *                         in every child tenant; ORG_READER doesn't
 *                         get that auto-provisioning, so even if the
 *                         UI hint were `true` they'd 403 at the
 *                         tenant RLS layer.
 *   - canExportReports  — CSV/PDF export of portfolio summary +
 *                         non-performing items. Available to both
 *                         org roles; the export only contains data
 *                         the role can see (snapshot data for both;
 *                         drill-down content for ORG_ADMIN only).
 *   - canManageTenants  — create new tenants under the org, link
 *                         existing tenants. ORG_ADMIN only.
 *   - canManageMembers  — add / remove / role-change org members.
 *                         ORG_ADMIN only.
 *   - canConfigureDashboard — add / update / delete the widgets that
 *                         compose the org-level dashboard. ORG_ADMIN
 *                         only. Read access to the rendered dashboard
 *                         is gated by `canViewPortfolio`; this flag
 *                         only controls the configuration layer
 *                         (Epic 41 — Configurable Dashboard Widget Engine).
 */
export type OrgPermissionSet = {
    canViewPortfolio: boolean;
    canDrillDown: boolean;
    canExportReports: boolean;
    canManageTenants: boolean;
    canManageMembers: boolean;
    canConfigureDashboard: boolean;
};

/**
 * Maps an OrgRole to its concrete permission booleans.
 *
 * The role-to-permission mapping is intentionally hard-coded (no
 * custom-role overrides at the org layer in v1) — org membership
 * roles are simple by design, and any future complexity is better
 * addressed by adding new roles than by per-org policy blobs.
 */
export function getOrgPermissions(role: OrgRole): OrgPermissionSet {
    switch (role) {
        case 'ORG_ADMIN':
            return {
                canViewPortfolio: true,
                canDrillDown: true,
                canExportReports: true,
                canManageTenants: true,
                canManageMembers: true,
                canConfigureDashboard: true,
            };
        case 'ORG_READER':
            return {
                // Portfolio summary only — no per-tenant drill-down,
                // no management. Future portfolio-only personas (e.g.
                // a board member who needs read-only attestation
                // visibility) slot in here.
                canViewPortfolio: true,
                canDrillDown: false,
                canExportReports: true,
                canManageTenants: false,
                canManageMembers: false,
                canConfigureDashboard: false,
            };
        default: {
            // Defensive — Prisma's enum is closed, so the runtime
            // should never reach here. Returning the zero-permission
            // bag matches the fail-closed posture of every other
            // permission helper in this file.
            const _exhaustive: never = role;
            void _exhaustive;
            return {
                canViewPortfolio: false,
                canDrillDown: false,
                canExportReports: false,
                canManageTenants: false,
                canManageMembers: false,
                canConfigureDashboard: false,
            };
        }
    }
}

// ─── Custom Role Helpers ───────────────────────────────────────────────────

/**
 * Validates that a JSON value conforms to the PermissionSet shape.
 * Returns a list of error strings; empty list = valid.
 *
 * Used at write-time (creating/updating custom roles) to prevent
 * saving malformed permission blobs.
 */
export function validatePermissionsJson(json: unknown): string[] {
    const errors: string[] = [];

    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
        return ['permissionsJson must be a non-null object'];
    }

    const obj = json as Record<string, unknown>;
    const expectedDomains = Object.keys(PERMISSION_SCHEMA) as (keyof PermissionSet)[];
    const actualDomains = Object.keys(obj);

    // Check for missing domains
    for (const domain of expectedDomains) {
        if (!(domain in obj)) {
            errors.push(`Missing permission domain: "${domain}"`);
            continue;
        }

        const domainValue = obj[domain];
        if (typeof domainValue !== 'object' || domainValue === null) {
            errors.push(`Permission domain "${domain}" must be an object`);
            continue;
        }

        const domainObj = domainValue as Record<string, unknown>;
        const expectedActions = PERMISSION_SCHEMA[domain];

        for (const action of expectedActions) {
            if (!(action in domainObj)) {
                errors.push(`Missing action "${domain}.${action}"`);
            } else if (typeof domainObj[action] !== 'boolean') {
                errors.push(`"${domain}.${action}" must be boolean, got ${typeof domainObj[action]}`);
            }
        }

        // Check for unexpected actions
        for (const action of Object.keys(domainObj)) {
            if (!expectedActions.includes(action)) {
                errors.push(`Unexpected action "${domain}.${action}"`);
            }
        }
    }

    // Check for unexpected domains
    for (const domain of actualDomains) {
        if (!expectedDomains.includes(domain as keyof PermissionSet)) {
            errors.push(`Unexpected permission domain: "${domain}"`);
        }
    }

    // Refuse OWNER-only permissions outright. A custom role's baseRole can
    // never be OWNER (`VALID_BASE_ROLES`), so granting these would let an ADMIN
    // mint themselves tenant-deletion / DEK-rotation / OWNER-management rights
    // — the exact boundary the OWNER/ADMIN split exists to hold.
    for (const { domain, action } of OWNER_ONLY_PERMISSIONS) {
        const bag = (obj as Record<string, Record<string, unknown>>)[domain];
        if (bag && bag[action] === true) {
            errors.push(
                `"${domain}.${action}" is OWNER-only and cannot be granted through a custom role`,
            );
        }
    }

    return errors;
}

/**
 * Safely parses a permissionsJson blob from the database into a typed PermissionSet.
 * Falls back to the baseRole's defaults for any missing or invalid fields.
 *
 * Used at read-time to ensure the runtime always has a complete, valid PermissionSet
 * even if the stored JSON is partially malformed (defensive programming).
 */
/**
 * Permissions a custom-role blob would grant that the GRANTOR does not hold.
 *
 * The principle is "you cannot give away what you do not have". Without it,
 * `admin.manage` — which gates custom-role CRUD — is effectively a grant of
 * every permission in the system: an ADMIN could mint a role carrying anything
 * and assign it to themselves. #353 closed the OWNER-only special case; this
 * closes the general class it belonged to.
 *
 * Deliberately compared against the grantor's OWN effective permissions rather
 * than the role's `baseRole`. Capping at the base role would forbid legitimate
 * tailoring — giving an EDITOR-based role a report export the ADMIN genuinely
 * holds is the entire point of custom roles. Capping at the grantor forbids
 * only escalation.
 *
 * Returns the offending `domain.action` keys, empty when nothing exceeds.
 */
export function permissionsExceeding(
    requested: unknown,
    grantor: PermissionSet,
): string[] {
    if (typeof requested !== 'object' || requested === null || Array.isArray(requested)) {
        return [];
    }
    const obj = requested as Record<string, Record<string, unknown>>;
    const over: string[] = [];

    for (const domain of Object.keys(PERMISSION_SCHEMA) as (keyof PermissionSet)[]) {
        const bag = obj[domain];
        if (typeof bag !== 'object' || bag === null) continue;
        const held = grantor[domain] as unknown as Record<string, boolean>;

        for (const action of PERMISSION_SCHEMA[domain]) {
            // Only a GRANT can escalate. Revoking something the grantor holds,
            // or leaving a key false, is always allowed.
            if (bag[action] === true && held?.[action] !== true) {
                over.push(`${domain}.${action}`);
            }
        }
    }
    return over;
}

export function parsePermissionsJson(json: unknown, baseRole: Role): PermissionSet {
    const defaults = getPermissionsForRole(baseRole);

    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
        return defaults;
    }

    const obj = json as Record<string, Record<string, unknown>>;
    const result = { ...defaults };

    for (const domain of Object.keys(PERMISSION_SCHEMA) as (keyof PermissionSet)[]) {
        if (domain in obj && typeof obj[domain] === 'object' && obj[domain] !== null) {
            const actions = PERMISSION_SCHEMA[domain];
            const domainResult: Record<string, boolean> = { ...defaults[domain] };

            for (const action of actions) {
                if (action in obj[domain] && typeof obj[domain][action] === 'boolean') {
                    domainResult[action] = obj[domain][action] as boolean;
                }
            }

            (result as Record<keyof PermissionSet, Record<string, boolean>>)[domain] = domainResult;
        }
    }

    // OWNER-only keys can never come from a custom role, whatever the stored
    // blob says. This is the read-time half of the guard: rows written before
    // `validatePermissionsJson` started rejecting them would otherwise keep
    // their escalation across a deploy.
    for (const { domain, action } of OWNER_ONLY_PERMISSIONS) {
        const bag = (result as Record<keyof PermissionSet, Record<string, boolean>>)[domain];
        if (bag && action in bag) bag[action] = false;
    }

    return result;
}
