/**
 * Custom roles cannot grant OWNER-only permissions.
 *
 * The hole this closes was real and reachable. `parsePermissionsJson` seeded
 * from the base role's defaults and then let ANY stored boolean win, with no
 * ceiling:
 *
 *   1. an ADMIN holds `admin.manage`, which gates custom-role CRUD;
 *   2. `validatePermissionsJson` checked shape only — never values;
 *   3. so they could store `{ admin: { tenant_lifecycle: true } }` against
 *      baseRole ADMIN, assign the role to themselves (no self-assignment
 *      guard, no "cannot grant what you don't hold" check), and
 *   4. `requirePermission('admin.tenant_lifecycle')` reads
 *      `ctx.appPermissions` — the very set `parsePermissionsJson` produced.
 *
 * That yields tenant deletion, DEK rotation and OWNER management: the whole
 * OWNER/ADMIN boundary from Epic 1. The custom-role EDITOR could not do it, but
 * every ADMIN could, via the API alone.
 *
 * The UI was not the practice. `roles/page.tsx` kept a hand-copied permission
 * schema that had silently drifted — missing exactly these two keys since they
 * were added three months after it was written — so the checkboxes never
 * rendered. That accident was the only thing making the escalation curl-only.
 *
 * Both halves are tested here because either alone leaves a gap: write-time
 * rejection does nothing for blobs already in the database, and read-time
 * forcing alone would let the DB hold a lie.
 */
import {
    validatePermissionsJson,
    parsePermissionsJson,
    getPermissionsForRole,
    OWNER_ONLY_PERMISSIONS,
} from '@/lib/permissions';
import { scopesToPermissions, VALID_SCOPES } from '@/lib/auth/api-key-auth';

const adminDefaults = getPermissionsForRole('ADMIN');

/** A structurally valid blob for an ADMIN-based custom role. */
function adminBlob(adminOverrides: Record<string, boolean> = {}) {
    return {
        ...adminDefaults,
        admin: { ...adminDefaults.admin, ...adminOverrides },
    };
}

describe('the OWNER-only key list is what the role model documents', () => {
    it('names exactly tenant_lifecycle and owner_management', () => {
        expect(OWNER_ONLY_PERMISSIONS.map((p) => `${p.domain}.${p.action}`).sort()).toEqual([
            'admin.owner_management',
            'admin.tenant_lifecycle',
        ]);
    });

    it('ADMIN does not hold them by default — the boundary this protects', () => {
        expect(adminDefaults.admin.tenant_lifecycle).toBe(false);
        expect(adminDefaults.admin.owner_management).toBe(false);
    });

    it('OWNER does hold them', () => {
        const owner = getPermissionsForRole('OWNER');
        expect(owner.admin.tenant_lifecycle).toBe(true);
        expect(owner.admin.owner_management).toBe(true);
    });
});

describe('write-time — validatePermissionsJson rejects escalation', () => {
    it('rejects granting tenant_lifecycle', () => {
        const errors = validatePermissionsJson(adminBlob({ tenant_lifecycle: true }));
        expect(errors.join(' ')).toMatch(/tenant_lifecycle.*OWNER-only/i);
    });

    it('rejects granting owner_management', () => {
        const errors = validatePermissionsJson(adminBlob({ owner_management: true }));
        expect(errors.join(' ')).toMatch(/owner_management.*OWNER-only/i);
    });

    it('rejects both at once, naming both', () => {
        const errors = validatePermissionsJson(
            adminBlob({ tenant_lifecycle: true, owner_management: true }),
        );
        expect(errors.filter((e) => /OWNER-only/i.test(e))).toHaveLength(2);
    });

    it('still ACCEPTS them set to false — the shape requires the keys present', () => {
        // The blob must carry every key or the completeness check fires; only
        // `true` is the escalation.
        expect(validatePermissionsJson(adminBlob())).toEqual([]);
    });

    it('does not block ordinary custom-role tailoring', () => {
        // A custom role granting an EDITOR something extra is legitimate and
        // must keep working — this guard is deliberately NOT a blanket
        // "custom roles may only subtract" cap.
        const editor = getPermissionsForRole('EDITOR');
        const tailored = { ...editor, reports: { ...editor.reports, export: true } };
        expect(validatePermissionsJson(tailored)).toEqual([]);
    });
});

describe('read-time — parsePermissionsJson neutralises a stored escalation', () => {
    it('forces tenant_lifecycle false even when the row says true', () => {
        // Simulates a row written BEFORE the write-time guard existed.
        const resolved = parsePermissionsJson(adminBlob({ tenant_lifecycle: true }), 'ADMIN');
        expect(resolved.admin.tenant_lifecycle).toBe(false);
    });

    it('forces owner_management false even when the row says true', () => {
        const resolved = parsePermissionsJson(adminBlob({ owner_management: true }), 'ADMIN');
        expect(resolved.admin.owner_management).toBe(false);
    });

    it('leaves the rest of the custom role intact', () => {
        const resolved = parsePermissionsJson(
            adminBlob({ tenant_lifecycle: true, scim: false }),
            'ADMIN',
        );
        expect(resolved.admin.tenant_lifecycle).toBe(false);
        // The legitimate part of the same blob still applies.
        expect(resolved.admin.scim).toBe(false);
        expect(resolved.admin.manage).toBe(true);
    });

    it('does not strip the keys from a genuine OWNER — they are role-derived, not custom', () => {
        // OWNER never goes through a custom role (VALID_BASE_ROLES excludes it),
        // so the static path must be untouched.
        const owner = getPermissionsForRole('OWNER');
        expect(owner.admin.tenant_lifecycle).toBe(true);
        expect(owner.admin.owner_management).toBe(true);
    });

    it('an ADMIN-based custom role cannot reach OWNER capability by any route', () => {
        // The end-to-end assertion: whatever the blob claims, the resolved set
        // that `requirePermission` reads denies both keys.
        const resolved = parsePermissionsJson(
            adminBlob({ tenant_lifecycle: true, owner_management: true }),
            'ADMIN',
        );
        for (const { domain, action } of OWNER_ONLY_PERMISSIONS) {
            expect(
                (resolved as unknown as Record<string, Record<string, boolean>>)[domain][action],
            ).toBe(false);
        }
    });
});

/**
 * The OTHER path that builds `appPermissions`.
 *
 * `parsePermissionsJson` is not the only producer — an API-key request gets its
 * permission set from `scopesToPermissions(scopes)` instead, on a completely
 * separate code path. It is currently SAFE, but for the same fragile reason the
 * roles editor was: `SCOPE_ACTION_MAP.admin` happens to list only
 * `manage/members/sso/scim`, and the `*` shortcut happens to return ADMIN's set
 * (where both keys are false).
 *
 * Both are hand-maintained lists. Adding `tenant_lifecycle` to the admin write
 * scope — or pointing the wildcard at OWNER — would hand an API key the
 * OWNER-only capabilities with nothing to stop it. These tests make that a CI
 * failure rather than a discovery.
 */
describe('API-key scopes cannot reach OWNER-only permissions', () => {
    it('no single valid scope grants them', () => {
        for (const scope of VALID_SCOPES) {
            const perms = scopesToPermissions([scope]);
            for (const { domain, action } of OWNER_ONLY_PERMISSIONS) {
                const bag = perms[domain] as unknown as Record<string, boolean>;
                expect({ scope, key: `${domain}.${action}`, value: bag[action] }).toEqual({
                    scope,
                    key: `${domain}.${action}`,
                    value: false,
                });
            }
        }
    });

    it('the full set of scopes at once does not grant them either', () => {
        // Guards against a combination effect no single-scope loop would catch.
        const perms = scopesToPermissions([...VALID_SCOPES]);
        for (const { domain, action } of OWNER_ONLY_PERMISSIONS) {
            expect((perms[domain] as unknown as Record<string, boolean>)[action]).toBe(false);
        }
    });

    it('the wildcard scope resolves to ADMIN, never OWNER', () => {
        const wildcard = scopesToPermissions(['*']);
        expect(wildcard.admin.tenant_lifecycle).toBe(false);
        expect(wildcard.admin.owner_management).toBe(false);
        // Positive practice: the wildcard really is broad, so the assertion
        // above is meaningful rather than passing on an empty set.
        expect(wildcard.admin.manage).toBe(true);
    });
});
