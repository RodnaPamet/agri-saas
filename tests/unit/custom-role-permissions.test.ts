/**
 * Epic 21 Phase 1 — Custom Role Permission Helpers
 *
 * Tests for validatePermissionsJson, parsePermissionsJson, and
 * backward compatibility of getPermissionsForRole.
 *
 * GRC teardown phase 2 removed the `practices`, `policies`, `vendors`,
 * `tests`, `frameworks` and `audits` permission domains. Every case that
 * used `practices` as its worked example is re-pointed at `evidence`
 * (four actions — view/upload/edit/download, the same arity `practices`
 * had was three, so the missing/unexpected-action cases still exercise
 * both directions) or `tasks`. No validator behaviour is asserted more
 * loosely than before.
 */
import {
    getPermissionsForRole,
    validatePermissionsJson,
    parsePermissionsJson,
    type PermissionSet,
} from '@/lib/permissions';

// ─── Helper: build a complete valid PermissionSet JSON ───

function makeValidPermissions(overrides: Partial<Record<keyof PermissionSet, Partial<Record<string, boolean>>>> = {}): PermissionSet {
    const base = getPermissionsForRole('READER');
    for (const [domain, actions] of Object.entries(overrides)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (base as any)[domain] = {
            ...(base as Record<string, Record<string, boolean>>)[domain],
            ...actions,
        };
    }
    return base;
}

// ═══════════════════════════════════════════════════════════════
//  getPermissionsForRole — backward compatibility
// ═══════════════════════════════════════════════════════════════

describe('getPermissionsForRole', () => {
    test('ADMIN gets full permissions', () => {
        const perms = getPermissionsForRole('ADMIN');
        expect(perms.admin.manage).toBe(true);
        expect(perms.admin.members).toBe(true);
        // GRC teardown phase 2 removed the practices + frameworks
        // domains; the bound (ADMIN holds the write tier AND the
        // privileged-config tier) is re-pointed at what survives.
        expect(perms.tasks.create).toBe(true);
        expect(perms.admin.scim).toBe(true);
    });

    test('READER gets view-only', () => {
        const perms = getPermissionsForRole('READER');
        expect(perms.evidence.view).toBe(true);
        expect(perms.evidence.upload).toBe(false);
        expect(perms.tasks.create).toBe(false);
        expect(perms.admin.manage).toBe(false);
    });

    test('every role produces a valid PermissionSet shape', () => {
        const roles = ['ADMIN', 'EDITOR', 'AUDITOR', 'READER', 'MECHANISATOR'] as const;
        for (const role of roles) {
            const perms = getPermissionsForRole(role);
            // Every PermissionSet must have all 5 domains. `knowledge`
            // joined the set with the KB ask surface — a role that resolves
            // without it would fail open or closed depending on the caller,
            // so the shape is asserted exhaustively rather than by subset.
            // `risks` left it with the risk register: 12 → 11. GRC teardown
            // phase 2 then removed practices, policies, vendors, tests,
            // frameworks and audits: 11 → 5. Still exhaustive — an added
            // or dropped domain fails here.
            expect(Object.keys(perms).sort()).toEqual([
                'admin', 'evidence', 'knowledge', 'reports', 'tasks',
            ]);
        }
    });
});

// ═══════════════════════════════════════════════════════════════
//  validatePermissionsJson
// ═══════════════════════════════════════════════════════════════

describe('validatePermissionsJson', () => {
    test('valid PermissionSet returns zero errors', () => {
        const perms = getPermissionsForRole('EDITOR');
        expect(validatePermissionsJson(perms)).toEqual([]);
    });

    test('null input returns error', () => {
        const errors = validatePermissionsJson(null);
        expect(errors).toEqual(['permissionsJson must be a non-null object']);
    });

    test('array input returns error', () => {
        const errors = validatePermissionsJson([]);
        expect(errors).toEqual(['permissionsJson must be a non-null object']);
    });

    test('string input returns error', () => {
        const errors = validatePermissionsJson('hello');
        expect(errors).toEqual(['permissionsJson must be a non-null object']);
    });

    test('missing domain is flagged', () => {
        const perms = getPermissionsForRole('READER');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const partial = { ...perms } as any;
        delete partial.admin;
        const errors = validatePermissionsJson(partial);
        expect(errors).toContain('Missing permission domain: "admin"');
    });

    test('missing action within a domain is flagged', () => {
        const perms = getPermissionsForRole('READER');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const modified = { ...perms, evidence: { view: true, upload: true } } as any;
        // "edit" is missing (GRC teardown phase 2 removed the practices
        // domain this case used to work on)
        const errors = validatePermissionsJson(modified);
        expect(errors).toContain('Missing action "evidence.edit"');
    });

    test('non-boolean action value is flagged', () => {
        const perms = getPermissionsForRole('READER');
        const modified = {
            ...perms,
            evidence: { view: 'yes', upload: false, edit: false, download: false },
        };
        const errors = validatePermissionsJson(modified);
        expect(errors).toContain('"evidence.view" must be boolean, got string');
    });

    test('unexpected domain is flagged', () => {
        const perms = getPermissionsForRole('READER');
        const modified = { ...perms, billing: { view: true } };
        const errors = validatePermissionsJson(modified);
        expect(errors).toContain('Unexpected permission domain: "billing"');
    });

    test('unexpected action within a domain is flagged', () => {
        const perms = getPermissionsForRole('READER');
        const modified = {
            ...perms,
            evidence: { ...perms.evidence, destroy: true },
        };
        const errors = validatePermissionsJson(modified);
        expect(errors).toContain('Unexpected action "evidence.destroy"');
    });

    test('domain that is not an object is flagged', () => {
        const perms = getPermissionsForRole('READER');
        const modified = { ...perms, evidence: 'invalid' };
        const errors = validatePermissionsJson(modified);
        expect(errors).toContain('Permission domain "evidence" must be an object');
    });

    test('custom role with all permissions valid passes', () => {
        const custom = makeValidPermissions({
            tasks: { create: true, edit: true },
            admin: { view: true, manage: true, members: true, sso: false, scim: false },
        });
        expect(validatePermissionsJson(custom)).toEqual([]);
    });
});

// ═══════════════════════════════════════════════════════════════
//  parsePermissionsJson
// ═══════════════════════════════════════════════════════════════

describe('parsePermissionsJson', () => {
    test('valid JSON returns exact PermissionSet', () => {
        const input = getPermissionsForRole('EDITOR');
        const result = parsePermissionsJson(input, 'READER');
        expect(result).toEqual(input);
    });

    test('null falls back to base role defaults', () => {
        const result = parsePermissionsJson(null, 'ADMIN');
        expect(result).toEqual(getPermissionsForRole('ADMIN'));
    });

    test('empty object falls back to base role for all domains', () => {
        const result = parsePermissionsJson({}, 'EDITOR');
        expect(result).toEqual(getPermissionsForRole('EDITOR'));
    });

    test('partial override merges with base role defaults', () => {
        const partial = {
            // GRC teardown phase 2 removed the practices domain this case
            // overrode; `tasks` carries the same merge semantics.
            tasks: { view: true, create: true, edit: true, assign: true },
            // Other domains missing — should fall back to READER defaults
        };
        const result = parsePermissionsJson(partial, 'READER');
        // Override applied
        expect(result.tasks.create).toBe(true);
        // Fallback preserved
        expect(result.admin).toEqual(getPermissionsForRole('READER').admin);
        expect(result.evidence).toEqual(getPermissionsForRole('READER').evidence);
    });

    test('invalid action types within a domain fall back to base role', () => {
        const input = {
            ...getPermissionsForRole('READER'),
            evidence: { view: 'not-a-boolean', upload: false, edit: false, download: false },
        };
        const result = parsePermissionsJson(input, 'ADMIN');
        // The invalid "view" falls back to ADMIN default (true)
        expect(result.evidence.view).toBe(true);
        // The valid booleans are preserved
        expect(result.evidence.upload).toBe(false);
    });

    test('missing actions within a domain fall back to base role', () => {
        const input = {
            ...getPermissionsForRole('READER'),
            // "edit" and "download" are missing from evidence
            evidence: { view: false, upload: true },
        };
        const result = parsePermissionsJson(input, 'EDITOR');
        // Present fields used
        expect(result.evidence.view).toBe(false);
        expect(result.evidence.upload).toBe(true);
        // Missing "edit" falls back to EDITOR default (true)
        expect(result.evidence.edit).toBe(true);
    });

    test('array input falls back to base role defaults', () => {
        const result = parsePermissionsJson([], 'AUDITOR');
        expect(result).toEqual(getPermissionsForRole('AUDITOR'));
    });
});
