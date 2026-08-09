/**
 * Epic 21 Phase 1 — Custom Role Permission Helpers
 *
 * Tests for validatePermissionsJson, parsePermissionsJson, and
 * backward compatibility of getPermissionsForRole.
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
        expect(perms.practices.create).toBe(true);
        expect(perms.frameworks.install).toBe(true);
    });

    test('READER gets view-only', () => {
        const perms = getPermissionsForRole('READER');
        expect(perms.practices.view).toBe(true);
        expect(perms.practices.create).toBe(false);
        expect(perms.admin.manage).toBe(false);
    });

    test('every role produces a valid PermissionSet shape', () => {
        const roles = ['ADMIN', 'EDITOR', 'AUDITOR', 'READER', 'MECHANISATOR'] as const;
        for (const role of roles) {
            const perms = getPermissionsForRole(role);
            // Every PermissionSet must have all 11 domains. `knowledge`
            // joined the set with the KB ask surface — a role that resolves
            // without it would fail open or closed depending on the caller,
            // so the shape is asserted exhaustively rather than by subset.
            // `risks` left it with the risk register: 12 → 11.
            expect(Object.keys(perms).sort()).toEqual([
                'admin', 'audits', 'practices', 'evidence', 'frameworks',
                'knowledge', 'policies', 'reports', 'tasks', 'tests',
                'vendors',
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
        const modified = { ...perms, practices: { view: true, create: true } } as any;
        // "edit" is missing
        const errors = validatePermissionsJson(modified);
        expect(errors).toContain('Missing action "practices.edit"');
    });

    test('non-boolean action value is flagged', () => {
        const perms = getPermissionsForRole('READER');
        const modified = {
            ...perms,
            practices: { view: 'yes', create: false, edit: false },
        };
        const errors = validatePermissionsJson(modified);
        expect(errors).toContain('"practices.view" must be boolean, got string');
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
            practices: { ...perms.practices, destroy: true },
        };
        const errors = validatePermissionsJson(modified);
        expect(errors).toContain('Unexpected action "practices.destroy"');
    });

    test('domain that is not an object is flagged', () => {
        const perms = getPermissionsForRole('READER');
        const modified = { ...perms, practices: 'invalid' };
        const errors = validatePermissionsJson(modified);
        expect(errors).toContain('Permission domain "practices" must be an object');
    });

    test('custom role with all permissions valid passes', () => {
        const custom = makeValidPermissions({
            practices: { create: true, edit: true },
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
            practices: { view: true, create: true, edit: true },
            // Other domains missing — should fall back to READER defaults
        };
        const result = parsePermissionsJson(partial, 'READER');
        // Override applied
        expect(result.practices.create).toBe(true);
        // Fallback preserved
        expect(result.admin).toEqual(getPermissionsForRole('READER').admin);
        expect(result.evidence).toEqual(getPermissionsForRole('READER').evidence);
    });

    test('invalid action types within a domain fall back to base role', () => {
        const input = {
            ...getPermissionsForRole('READER'),
            practices: { view: 'not-a-boolean', create: false, edit: false },
        };
        const result = parsePermissionsJson(input, 'ADMIN');
        // The invalid "view" falls back to ADMIN default (true)
        expect(result.practices.view).toBe(true);
        // The valid booleans are preserved
        expect(result.practices.create).toBe(false);
    });

    test('missing actions within a domain fall back to base role', () => {
        const input = {
            ...getPermissionsForRole('READER'),
            // "edit" is missing from practices
            practices: { view: false, create: true },
        };
        const result = parsePermissionsJson(input, 'EDITOR');
        // Present fields used
        expect(result.practices.view).toBe(false);
        expect(result.practices.create).toBe(true);
        // Missing "edit" falls back to EDITOR default (true)
        expect(result.practices.edit).toBe(true);
    });

    test('array input falls back to base role defaults', () => {
        const result = parsePermissionsJson([], 'AUDITOR');
        expect(result).toEqual(getPermissionsForRole('AUDITOR'));
    });
});
