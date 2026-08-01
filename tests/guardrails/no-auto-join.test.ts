/**
 * Guardrail: TenantMembership is created ONLY through the curated,
 * explicit paths below. A seventh site is a privilege-escalation
 * risk (Epic 1 GAP-01 — auto-ADMIN on OAuth sign-in — was exactly
 * this class of bug) and must pass review before being allowlisted.
 *
 * This test is structural: it greps for `tenantMembership.create`,
 * `tenantMembership.upsert`, and `tenantMembership.createMany`
 * call sites in src/ and fails if any match outside the allowlist.
 *
 * When adding a new legitimate creation path:
 *   1. Add the file to `ALLOWLISTED_MEMBERSHIP_SITES` below with a
 *      one-line `reason` describing why this path is safe (gated
 *      by what? audit-logged how? email-bound?).
 *   2. Confirm the path carries a meaningful audit entry.
 *   3. Make the review visible in the PR diff.
 *
 * Also asserts:
 *   - `ensureDefaultTenantMembership` (the Epic 1 vulnerability
 *     function name) does not reappear anywhere in src/.
 */

import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

interface AllowlistedSite {
    /** Path relative to repo root. */
    file: string;
    /** Why this file is a legitimate membership-creation site. */
    reason: string;
}

const ALLOWLISTED_MEMBERSHIP_SITES: ReadonlyArray<AllowlistedSite> = [
    {
        file: 'src/app-layer/usecases/tenant-invites.ts',
        reason:
            'Epic 1 canonical path. redeemInvite consumes a TenantInvite ' +
            'token atomically (updateMany with expiresAt + acceptedAt + ' +
            'revokedAt predicates) and email-binds to the signed-in user ' +
            'before creating the membership. Audit-chained via ' +
            'appendAuditEntry MEMBER_INVITE_ACCEPTED.',
    },
    {
        file: 'src/app-layer/usecases/tenant-lifecycle.ts',
        reason:
            'Epic 1 platform-admin tenant creation. createTenantWithOwner ' +
            'runs under PLATFORM_ADMIN_API_KEY auth (no user session) and ' +
            'atomically bootstraps Tenant + OWNER membership + ' +
            'TenantOnboarding. Audit-chained as TENANT_CREATED + ' +
            'TENANT_MEMBERSHIP_GRANTED.',
    },
    {
        file: 'src/app/api/auth/register/route.ts',
        reason:
            'Credentials self-service signup (AUTH_TEST_MODE-gated). The ' +
            'signing-up user creates their own tenant and becomes its ' +
            'sole OWNER — this is the "I am my own tenant" path, separate ' +
            'from platform-admin-mediated tenant creation.',
    },
    {
        file: 'src/app/api/staging/seed/route.ts',
        reason:
            'Staging-only seed endpoint. Upserts a deterministic ' +
            'tenant+admin pair so E2E tests have a starting fixture. ' +
            'Not reachable in production (the route carves itself out).',
    },
    {
        file: 'src/app-layer/usecases/sso.ts',
        reason:
            'SSO-based user provisioning. The configured IdP is the source ' +
            'of truth for identity + tenant assignment; the role is clamped ' +
            'to READER|EDITOR (never ADMIN, never OWNER). Audit-chained as ' +
            'SSO_USER_PROVISIONED.',
    },
    {
        file: 'src/app-layer/usecases/scim-users.ts',
        reason:
            'SCIM 2.0 provisioning. Enterprise identity-sync protocol; ' +
            'the SCIM token itself is tenant-scoped and authorised by ' +
            'admin.scim. Audit-chained as SCIM_USER_PROVISIONED.',
    },
    {
        file: 'src/app-layer/usecases/org-provisioning.ts',
        reason:
            'Epic O-2 hub-and-spoke ORG_ADMIN auto-provisioning. ' +
            'Fan-out creates AUDITOR (read-only) memberships in every ' +
            'tenant under the org, tagged with provisionedByOrgId so ' +
            'deprovisionOrgAdmin can distinguish auto-created from ' +
            'manually-granted rows. createMany with skipDuplicates ' +
            'preserves any pre-existing manual membership; the role ' +
            'is hard-coded to AUDITOR (never higher). Audit emission ' +
            'happens at the calling org-level API route, where the ' +
            'OrgContext is in scope.',
    },
    {
        file: 'src/app-layer/usecases/org-tenants.ts',
        reason:
            'Epic O-2 createTenantUnderOrg. Creates the OWNER ' +
            'TenantMembership for the user authorised on the OrgContext ' +
            '(canManageTenants gate enforced at the route layer). ' +
            'Creator is the ORG_ADMIN making the call — the OWNER row ' +
            'is manually granted (provisionedByOrgId NULL) so it ' +
            'survives the creator\'s potential later removal as ' +
            'ORG_ADMIN. After the transaction commits, ' +
            'provisionAllOrgAdminsToTenant fans AUDITOR rows for OTHER ' +
            'org-admins via the already-allowlisted provisioning service.',
    },
];

const MEMBERSHIP_CREATION_PATTERN = /\btenantMembership\.(create|upsert|createMany)\b/;
const ORG_MEMBERSHIP_CREATION_PATTERN = /\borgMembership\.(create|upsert|createMany)\b/;

/**
 * Epic D — explicit allowlist for OrgMembership creation sites.
 * Same shape as TenantMembership: a new entry is a privilege-
 * escalation risk and must pass review.
 */
interface OrgAllowlistedSite {
    file: string;
    reason: string;
}

const ALLOWLISTED_ORG_MEMBERSHIP_SITES: ReadonlyArray<OrgAllowlistedSite> = [
    {
        file: 'src/app-layer/usecases/org-members.ts',
        reason:
            'Epic O-2 — addOrgMember / removeOrgMember / changeOrgMemberRole. ' +
            'All three are gated at the route layer by canManageMembers ' +
            '(ORG_ADMIN-only) and emit OrgAuditLog rows.',
    },
    {
        file: 'src/app-layer/usecases/org-invites.ts',
        reason:
            'Epic D canonical path. redeemOrgInvite consumes an OrgInvite ' +
            'token atomically (updateMany predicate) and email-binds to ' +
            'the signed-in user. Audit-chained as ORG_INVITE_REDEEMED + ' +
            'ORG_MEMBER_ADDED.',
    },
    {
        file: 'src/app/api/org/route.ts',
        reason:
            'Epic O-2 self-service org creation. The signed-in user creates ' +
            'their own organization and becomes its sole ORG_ADMIN — same ' +
            '"I am my own tenant" pattern as the credentials-signup tenant ' +
            'creation. The user only gains privilege over the org they ' +
            'just created; they cannot affect any other org.',
    },
];

describe('Guardrail: TenantMembership creation sites are allowlisted', () => {
    it('every call site is one of the ALLOWLISTED_MEMBERSHIP_SITES entries', async () => {
        const files = await glob('**/*.ts', {
            cwd: SRC,
            ignore: ['**/*.d.ts', '**/*.test.ts', '**/*.spec.ts'],
            posix: true,
        });

        const allowlistedRelPaths = new Set(
            ALLOWLISTED_MEMBERSHIP_SITES.map((s) => s.file),
        );
        const violations: string[] = [];

        for (const rel of files) {
            const full = path.join(SRC, rel);
            const content = fs.readFileSync(full, 'utf8');
            if (!MEMBERSHIP_CREATION_PATTERN.test(content)) continue;

            const srcRelPath = `src/${rel}`;
            if (!allowlistedRelPaths.has(srcRelPath)) {
                violations.push(srcRelPath);
            }
        }

        if (violations.length > 0) {
            const msg = [
                'Unallowlisted TenantMembership creation site(s):',
                ...violations.map((v) => `  - ${v}`),
                '',
                'If this is a legitimate new creation path, add the file to',
                'ALLOWLISTED_MEMBERSHIP_SITES in tests/guardrails/no-auto-join.test.ts',
                'with a one-line reason describing why it is safe.',
            ].join('\n');
            throw new Error(msg);
        }

        expect(violations).toEqual([]);
    });

    it('every allowlisted file actually exists on disk + contains the pattern', () => {
        for (const site of ALLOWLISTED_MEMBERSHIP_SITES) {
            const full = path.join(ROOT, site.file);
            expect(fs.existsSync(full)).toBe(true);
            const content = fs.readFileSync(full, 'utf8');
            expect(MEMBERSHIP_CREATION_PATTERN.test(content)).toBe(true);
        }
    });

    it('ensureDefaultTenantMembership function name is gone from src/', async () => {
        // Epic 1 GAP-01: this was the auto-ADMIN vulnerability.
        // Removed in PR 4. This assertion prevents reintroduction.
        const files = await glob('**/*.ts', {
            cwd: SRC,
            ignore: ['**/*.d.ts'],
            posix: true,
        });

        const matches: string[] = [];
        for (const rel of files) {
            const content = fs.readFileSync(path.join(SRC, rel), 'utf8');
            if (/ensureDefaultTenantMembership/.test(content)) {
                matches.push(`src/${rel}`);
            }
        }

        expect(matches).toEqual([]);
    });
});

// ─── Epic D — OrgMembership creation sites ───────────────────────

describe('Guardrail: OrgMembership creation sites are allowlisted', () => {
    it('every call site is one of the ALLOWLISTED_ORG_MEMBERSHIP_SITES entries', async () => {
        const files = await glob('**/*.ts', {
            cwd: SRC,
            ignore: ['**/*.d.ts', '**/*.test.ts', '**/*.spec.ts'],
            posix: true,
        });

        const allowlistedRelPaths = new Set(
            ALLOWLISTED_ORG_MEMBERSHIP_SITES.map((s) => s.file),
        );
        const violations: string[] = [];

        for (const rel of files) {
            const full = path.join(SRC, rel);
            const content = fs.readFileSync(full, 'utf8');
            if (!ORG_MEMBERSHIP_CREATION_PATTERN.test(content)) continue;

            const srcRelPath = `src/${rel}`;
            if (!allowlistedRelPaths.has(srcRelPath)) {
                violations.push(srcRelPath);
            }
        }

        if (violations.length > 0) {
            const msg = [
                'Unallowlisted OrgMembership creation site(s):',
                ...violations.map((v) => `  - ${v}`),
                '',
                'If this is a legitimate new creation path, add the file to',
                'ALLOWLISTED_ORG_MEMBERSHIP_SITES in tests/guardrails/no-auto-join.test.ts',
                'with a one-line reason describing why it is safe (gated by what?',
                'audit-logged how? email-bound?).',
            ].join('\n');
            throw new Error(msg);
        }

        expect(violations).toEqual([]);
    });

    it('every allowlisted org-membership file actually exists + contains the pattern', () => {
        for (const site of ALLOWLISTED_ORG_MEMBERSHIP_SITES) {
            const full = path.join(ROOT, site.file);
            expect(fs.existsSync(full)).toBe(true);
            const content = fs.readFileSync(full, 'utf8');
            expect(ORG_MEMBERSHIP_CREATION_PATTERN.test(content)).toBe(true);
        }
    });

    it('ensureDefaultOrgMembership function name is gone from src/', async () => {
        // Epic D explicit hardening — there is no auto-bootstrap of
        // org membership today, and this sentinel prevents one from
        // being introduced silently. If any future feature needs a
        // dev-time bootstrap, it must be gated behind an env flag
        // (default false in production) and named explicitly so
        // operators can audit + disable.
        const files = await glob('**/*.ts', {
            cwd: SRC,
            ignore: ['**/*.d.ts'],
            posix: true,
        });

        const matches: string[] = [];
        for (const rel of files) {
            const content = fs.readFileSync(path.join(SRC, rel), 'utf8');
            if (/ensureDefaultOrgMembership/.test(content)) {
                matches.push(`src/${rel}`);
            }
        }

        expect(matches).toEqual([]);
    });
});
