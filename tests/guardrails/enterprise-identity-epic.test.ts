/**
 * Epic 21: Enterprise Identity — Regression Guards
 *
 * Structural tests that verify all Enterprise Identity deliverables
 * (custom roles + API keys) remain wired correctly. These are fast,
 * static-analysis tests (no DB, no network).
 *
 * Guards:
 *   1. Custom Role schema — model, fields, relations, fallback safety
 *   2. API Key schema — hashed storage, scopes, expiry, tenant FK
 *   3. Permission resolution — custom role path vs enum-role fallback
 *   4. API key auth — scope model, tenant isolation, coexistence with sessions
 *   5. Admin routes — coverage, guard imports
 *   6. Context integration — API key + session auth paths
 */
import * as fs from 'fs';
import * as path from 'path';
import { readPrismaSchema } from '../helpers/prisma-schema';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const schema = readPrismaSchema();
const tenantContext = read('src/lib/tenant-context.ts');
const permissions = read('src/lib/permissions.ts');
const apiKeyAuth = read('src/lib/auth/api-key-auth.ts');
const appContext = read('src/app-layer/context.ts');
const requestTypes = read('src/app-layer/types.ts');

// ─── 1. Custom Role Schema ──────────────────────────────────────────

describe('Custom Role Schema', () => {
    test('TenantCustomRole model exists', () => {
        expect(schema).toContain('model TenantCustomRole');
    });

    test('has permissionsJson field (Json type)', () => {
        expect(schema).toMatch(/permissionsJson\s+Json/);
    });

    test('has baseRole field for fallback', () => {
        expect(schema).toMatch(/baseRole\s+Role/);
    });

    test('has isActive field for soft-delete', () => {
        // TenantCustomRole should have isActive for safe soft-deletion
        const customRoleBlock = schema.slice(
            schema.indexOf('model TenantCustomRole'),
            schema.indexOf('}', schema.indexOf('model TenantCustomRole')) + 1
        );
        expect(customRoleBlock).toContain('isActive');
    });

    test('has tenantId FK for tenant isolation', () => {
        const block = schema.slice(
            schema.indexOf('model TenantCustomRole'),
            schema.indexOf('}', schema.indexOf('model TenantCustomRole')) + 1
        );
        expect(block).toContain('tenantId');
        expect(block).toContain('Tenant');
    });

    test('TenantMembership has nullable customRoleId', () => {
        const block = schema.slice(
            schema.indexOf('model TenantMembership'),
            schema.indexOf('}', schema.indexOf('model TenantMembership') + 10) + 1
        );
        expect(block).toContain('customRoleId');
        expect(block).toMatch(/customRoleId\s+String\?/);
    });

    test('customRoleId uses SetNull on delete for safe cleanup', () => {
        const block = schema.slice(
            schema.indexOf('model TenantMembership'),
            schema.indexOf('}', schema.indexOf('model TenantMembership') + 10) + 1
        );
        expect(block).toContain('SetNull');
    });

    test('enum Role still exists (backward compat)', () => {
        expect(schema).toContain('enum Role');
        expect(schema).toContain('ADMIN');
        expect(schema).toContain('EDITOR');
        expect(schema).toContain('AUDITOR');
        expect(schema).toContain('READER');
    });
});

// ─── 2. API Key Schema ──────────────────────────────────────────────

describe('API Key Schema', () => {
    test('TenantApiKey model exists', () => {
        expect(schema).toContain('model TenantApiKey');
    });

    const apiKeyBlock = (() => {
        const start = schema.indexOf('model TenantApiKey');
        const end = schema.indexOf('}', start) + 1;
        return schema.slice(start, end);
    })();

    test('has keyHash field (not plaintext)', () => {
        expect(apiKeyBlock).toContain('keyHash');
        expect(apiKeyBlock).not.toContain('keyPlaintext');
        expect(apiKeyBlock).not.toContain('keySecret');
    });

    test('has keyPrefix for identification without exposure', () => {
        expect(apiKeyBlock).toContain('keyPrefix');
    });

    test('keyHash has unique index', () => {
        expect(apiKeyBlock).toMatch(/@@unique\(\[keyHash\]\)/);
    });

    test('has scopes field (Json)', () => {
        expect(apiKeyBlock).toMatch(/scopes\s+Json/);
    });

    test('has expiresAt (nullable = optional expiry)', () => {
        expect(apiKeyBlock).toMatch(/expiresAt\s+DateTime\?/);
    });

    test('has revokedAt (nullable = not revoked)', () => {
        expect(apiKeyBlock).toMatch(/revokedAt\s+DateTime\?/);
    });

    test('has lastUsedAt for usage tracking', () => {
        expect(apiKeyBlock).toContain('lastUsedAt');
    });

    test('has tenantId FK for tenant isolation', () => {
        expect(apiKeyBlock).toContain('tenantId');
        expect(apiKeyBlock).toContain('Tenant');
    });

    test('has createdById FK for auditability', () => {
        expect(apiKeyBlock).toContain('createdById');
    });

    test('has tenant index for query performance', () => {
        expect(apiKeyBlock).toContain('@@index([tenantId]');
    });
});

// ─── 3. Permission Resolution ───────────────────────────────────────

describe('Permission Resolution', () => {
    test('tenant-context.ts resolves custom role permissions when present', () => {
        expect(tenantContext).toContain('parsePermissionsJson');
        expect(tenantContext).toContain('membership.customRole');
    });

    test('falls back to enum role when no custom role', () => {
        expect(tenantContext).toContain('getPermissionsForRole(membership.role)');
    });

    test('uses baseRole as fallback in parsePermissionsJson', () => {
        expect(tenantContext).toContain('customRole.baseRole');
    });

    test('permissions.ts has validatePermissionsJson', () => {
        expect(permissions).toContain('export function validatePermissionsJson');
    });

    test('permissions.ts has parsePermissionsJson', () => {
        expect(permissions).toContain('export function parsePermissionsJson');
    });

    test('PermissionSet covers all resource domains', () => {
        const domains = ['controls', 'evidence', 'policies', 'tasks',
            'vendors', 'tests', 'frameworks', 'audits', 'reports', 'admin'];
        for (const domain of domains) {
            expect(permissions).toContain(`${domain}:`);
        }
    });
});

// ─── 4. API Key Auth Module ─────────────────────────────────────────

describe('API Key Auth Module', () => {
    test('uses SHA-256 hashing (not bcrypt)', () => {
        // The actual hash function must use sha256
        expect(apiKeyAuth).toContain("createHash('sha256')");
        // No bcrypt import or require (comments mentioning bcrypt are fine)
        expect(apiKeyAuth).not.toMatch(/import.*bcrypt/);
        expect(apiKeyAuth).not.toMatch(/require.*bcrypt/);
    });

    test('API key prefix is defined and distinctive', () => {
        expect(apiKeyAuth).toContain("API_KEY_PREFIX = 'iflk_'");
    });

    test('key generation creates cryptographically random keys', () => {
        expect(apiKeyAuth).toContain('crypto.randomBytes');
    });

    test('verifies expiry before granting access', () => {
        expect(apiKeyAuth).toContain('expiresAt');
        expect(apiKeyAuth).toContain('expired');
    });

    test('verifies revocation before granting access', () => {
        expect(apiKeyAuth).toContain('revokedAt');
        expect(apiKeyAuth).toContain('revoked');
    });

    test('updates lastUsedAt without blocking auth (fire-and-forget)', () => {
        expect(apiKeyAuth).toContain('updateLastUsed');
        expect(apiKeyAuth).toContain('.catch');
    });

    test('has scope enforcement function', () => {
        expect(apiKeyAuth).toContain('enforceApiKeyScope');
    });

    test('has scope validation function', () => {
        expect(apiKeyAuth).toContain('validateScopes');
    });

    test('scope model maps to PermissionSet domains', () => {
        expect(apiKeyAuth).toContain('scopesToPermissions');
        expect(apiKeyAuth).toContain('SCOPE_ACTION_MAP');
    });

    test('full-access wildcard (*) grants ADMIN permissions', () => {
        expect(apiKeyAuth).toContain("scopes.includes('*')");
        expect(apiKeyAuth).toContain("getPermissionsForRole('ADMIN')");
    });
});

// ─── 5. Context Integration ─────────────────────────────────────────

describe('Context Integration', () => {
    test('getTenantCtx tries API key auth before session', () => {
        expect(appContext).toContain('tryApiKeyAuth');
    });

    test('getLegacyCtx tries API key auth before session', () => {
        // Both context builders should check for API key
        const fnBodies = appContext.split('export async function');
        const legacyCtx = fnBodies.find(b => b.includes('getLegacyCtx'));
        if (legacyCtx) {
            expect(legacyCtx).toContain('tryApiKeyAuth');
        }
    });

    test('API key auth returns null for non-API-key tokens (no session conflict)', () => {
        expect(appContext).toContain('isApiKeyToken');
        expect(appContext).toContain('return null');
    });

    test('API key auth throws unauthorized for invalid API keys (no fallthrough)', () => {
        expect(appContext).toContain('unauthorized');
    });

    test('RequestContext has apiKeyId for M2M detection', () => {
        expect(requestTypes).toContain('apiKeyId');
    });

    test('RequestContext has apiKeyScopes for scope enforcement', () => {
        expect(requestTypes).toContain('apiKeyScopes');
    });

    test('apiKeyId and apiKeyScopes are optional (session auth compatibility)', () => {
        expect(requestTypes).toContain('apiKeyId?: string');
        expect(requestTypes).toContain('apiKeyScopes?: string[]');
    });
});

// ─── 6. Admin Route Coverage ────────────────────────────────────────

describe('Admin UI & Routes Coverage', () => {
    test('custom roles admin page exists', () => {
        expect(fs.existsSync(
            path.join(ROOT, 'src/app/t/[tenantSlug]/(app)/admin/roles/page.tsx')
        )).toBe(true);
    });

    test('api-keys admin page exists', () => {
        expect(fs.existsSync(
            path.join(ROOT, 'src/app/t/[tenantSlug]/(app)/admin/api-keys/page.tsx')
        )).toBe(true);
    });

    test('custom roles API routes exist', () => {
        expect(fs.existsSync(
            path.join(ROOT, 'src/app/api/t/[tenantSlug]/admin/roles/route.ts')
        )).toBe(true);
        expect(fs.existsSync(
            path.join(ROOT, 'src/app/api/t/[tenantSlug]/admin/roles/[roleId]/route.ts')
        )).toBe(true);
    });

    test('api-keys API routes exist', () => {
        expect(fs.existsSync(
            path.join(ROOT, 'src/app/api/t/[tenantSlug]/admin/api-keys/route.ts')
        )).toBe(true);
        expect(fs.existsSync(
            path.join(ROOT, 'src/app/api/t/[tenantSlug]/admin/api-keys/[keyId]/route.ts')
        )).toBe(true);
    });

    test('admin routes are gated by an authorisation guard', () => {
        // Epic C.1 / D.3 — every admin route uses
        // `requirePermission(<key>, …)` from
        // `@/lib/security/permission-middleware` (which also writes the
        // `AUTHZ_DENIED` audit row on denial). The legacy `requireAdminCtx`
        // role-tier guard was removed once the migration completed; the
        // ratchet at `no-legacy-admin-guard.test.ts` keeps it gone.
        const ADMIN_GUARDS = /requirePermission/;
        const rolesRoute = read('src/app/api/t/[tenantSlug]/admin/roles/route.ts');
        const apiKeysRoute = read('src/app/api/t/[tenantSlug]/admin/api-keys/route.ts');
        expect(rolesRoute).toMatch(ADMIN_GUARDS);
        expect(apiKeysRoute).toMatch(ADMIN_GUARDS);
    });

    test('custom roles usecase validates permissions JSON on create', () => {
        const usecases = read('src/app-layer/usecases/custom-roles.ts');
        expect(usecases).toContain('validatePermissionsJson');
    });

    test('api-keys usecase validates scopes on create', () => {
        const usecases = read('src/app-layer/usecases/api-keys.ts');
        expect(usecases).toContain('validateScopes');
    });
});

// ─── 7. Migration Safety ────────────────────────────────────────────

describe('Migration Safety', () => {
    test('TenantCustomRole migration file exists', () => {
        const migDir = path.join(ROOT, 'prisma/migrations');
        const dirs = fs.readdirSync(migDir);
        const crMigration = dirs.find(d => d.includes('custom_role'));
        expect(crMigration).toBeDefined();
    });

    test('TenantApiKey migration file exists', () => {
        const migDir = path.join(ROOT, 'prisma/migrations');
        const dirs = fs.readdirSync(migDir);
        const akMigration = dirs.find(d => d.includes('api_key'));
        expect(akMigration).toBeDefined();
    });

    test('customRoleId is nullable (safe for existing memberships)', () => {
        expect(schema).toMatch(/customRoleId\s+String\?/);
    });

    test('revokedAt is nullable (safe for active keys)', () => {
        const block = schema.slice(
            schema.indexOf('model TenantApiKey'),
            schema.indexOf('}', schema.indexOf('model TenantApiKey')) + 1
        );
        expect(block).toMatch(/revokedAt\s+DateTime\?/);
    });

    test('expiresAt is nullable (keys can be permanent)', () => {
        const block = schema.slice(
            schema.indexOf('model TenantApiKey'),
            schema.indexOf('}', schema.indexOf('model TenantApiKey')) + 1
        );
        expect(block).toMatch(/expiresAt\s+DateTime\?/);
    });
});
