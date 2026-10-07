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
            'Epic 1 canonical path. TWO entry points, both requiring an ' +
            'admin-created TenantInvite: redeemInvite consumes a token ' +
            'atomically (updateMany with expiresAt + acceptedAt + ' +
            'revokedAt predicates) and email-binds to the signed-in user; ' +
            'redeemPendingInvitesByEmail matches a pending invite against ' +
            'an IdP-VERIFIED sign-in email, making the emailed link ' +
            'optional. The latter is OAuth-only — src/auth.ts passes ' +
            'emailVerifiedByIdp=false for credentials, whose email is ' +
            'self-asserted — and is still not auto-join: no invite means ' +
            'no membership. Both share finalizeInviteRedemption and are ' +
            'audit-chained via appendAuditEntry MEMBER_INVITE_ACCEPTED.',
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

/**
 * The NESTED shape, which the delegate pattern above cannot see (P3.10).
 *
 * `prisma.user.create({ data: { tenantMemberships: { create: {...} } } })`
 * creates a TenantMembership without the string `tenantMembership.create`
 * appearing anywhere — the relation field is PLURAL, so `\btenantMembership\.`
 * does not match it. A nested write is therefore invisible to the delegate
 * detector, and "invisible" is the whole problem this guardrail exists to
 * prevent: a membership nobody reviewed.
 *
 * Checked against the live tree when this was added: the three nested uses of
 * `tenantMemberships` in `src/` are all READS —
 * `unverified-account-sweep.ts` filters with `{ none: {} }`, and `sso.ts` plus
 * `auth/me/route.ts` use `include`/`select`/`where`. So this closes a
 * detector blind spot rather than a live hole, which is the right time to
 * close one.
 *
 * The window is short and the verb list closed, so a read cannot trip it —
 * the mutation proof below pins all three real read shapes as NON-matches,
 * because a detector that flagged them would be turned off within a week.
 */
const NESTED_MEMBERSHIP_CREATION_PATTERN =
    /tenantMemberships\s*:\s*\{[^}]{0,120}?\b(create|createMany|connectOrCreate|upsert)\s*:/;

/**
 * Does this file create a TenantMembership? ONE definition, used by the real
 * scan AND by the mutation proof.
 *
 * Extracted so the proof exercises the decision the guardrail actually makes.
 * A proof that re-implemented the check would be testing its own copy — the
 * failure mode where a guard and its evidence drift apart and both look fine.
 */
export function createsTenantMembership(content: string): boolean {
    return (
        MEMBERSHIP_CREATION_PATTERN.test(content) ||
        NESTED_MEMBERSHIP_CREATION_PATTERN.test(content)
    );
}
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
            if (!createsTenantMembership(content)) continue;

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

// ═══════════════════════════════════════════════════════════════════
//  P3.10 — the mutation proof: no ID-to-membership path can hide
// ═══════════════════════════════════════════════════════════════════
//
//  #1194's hardening list asks for "a mutation proof that no
//  ID-to-membership path exists". The guardrail above enforces that by
//  allowlisting every TenantMembership creation site — but until now nothing
//  proved the DETECTOR could see a new one. A scan that matched nothing would
//  report "no violations" forever and read exactly like a clean repo.
//
//  So this exercises `createsTenantMembership`, the same decision the scan
//  makes, against the shapes a real bypass would take.

describe('P3.10 mutation proof: the membership detector has teeth', () => {
    describe('it SEES every shape that creates a membership', () => {
        it.each([
            ['delegate create', 'await tx.tenantMembership.create({ data: { role: "OWNER" } });'],
            ['delegate upsert', 'await db.tenantMembership.upsert({ where: w, create: c, update: u });'],
            ['delegate createMany', 'await prisma.tenantMembership.createMany({ data: rows });'],
            [
                'NESTED create through the relation',
                'await prisma.user.create({ data: { email, tenantMemberships: { create: { tenantId, role: "OWNER" } } } });',
            ],
            [
                'NESTED createMany',
                'await prisma.user.update({ where: { id }, data: { tenantMemberships: { createMany: { data: rows } } } });',
            ],
            [
                'NESTED connectOrCreate',
                'await prisma.user.update({ data: { tenantMemberships: { connectOrCreate: { where: w, create: c } } } });',
            ],
            [
                'NESTED upsert',
                'await prisma.user.update({ data: { tenantMemberships: { upsert: { where: w, create: c, update: u } } } });',
            ],
        ])('%s', (_label, source) => {
            expect(createsTenantMembership(source)).toBe(true);
        });

        it('the nested shapes were INVISIBLE before P3.10', () => {
            // The regression this closes, stated as a fact rather than a
            // comment. The delegate pattern alone cannot match a nested write,
            // because the relation field is PLURAL — so a membership could
            // have been created in an unallowlisted file with nothing failing.
            const nested =
                'await prisma.user.create({ data: { tenantMemberships: { create: { tenantId, role: "OWNER" } } } });';
            expect(MEMBERSHIP_CREATION_PATTERN.test(nested)).toBe(false);
            expect(createsTenantMembership(nested)).toBe(true);
        });
    });

    describe('…and it does NOT fire on the reads, which is what keeps it on', () => {
        // These three are the ACTUAL nested uses in src/ at the time this was
        // written. A detector that flagged them would be disabled within a
        // week, so they are pinned as non-matches by their real shapes rather
        // than by invented ones.
        it.each([
            [
                'unverified-account-sweep filter',
                'where: { emailVerified: null, tenantMemberships: { none: {} }, orgMemberships: { none: {} } }',
            ],
            [
                'sso.ts include',
                'select: { id: true, tenantMemberships: { include: { tenant: { select: { id: true } } } } }',
            ],
            [
                'auth/me select+where',
                'tenantMemberships: { where: { status: "ACTIVE" }, orderBy: { createdAt: "asc" }, take: 1, select: { role: true } }',
            ],
        ])('%s is not a creation', (_label, source) => {
            expect(createsTenantMembership(source)).toBe(false);
        });

        it.each([
            ['update', 'await tx.tenantMembership.update({ where: { id }, data: { role } });'],
            ['delete', 'await tx.tenantMembership.delete({ where: { id } });'],
            ['findMany', 'await db.tenantMembership.findMany({ where: { tenantId } });'],
            ['count', 'await db.tenantMembership.count({ where: { tenantId } });'],
        ])('delegate %s is not a creation', (_label, source) => {
            expect(createsTenantMembership(source)).toBe(false);
        });
    });

    it('a COMMENT mentioning a creation DOES trip it — deliberately', () => {
        // Unusual, and the opposite of what most guards in this repo want.
        // Here it is correct: stripping comments is the only way a real call
        // could hide, because a write can be assembled inside a template
        // string or a line the stripper would eat. A false positive costs one
        // allowlist entry with a reason; a false negative costs a membership
        // nobody reviewed.
        const comment = '// never call tenantMembership.create here — see no-auto-join';
        expect(createsTenantMembership(comment)).toBe(true);
    });

    it('the detector is not a constant — an unrelated file is clean', () => {
        // The control that makes every `toBe(false)` above mean something. A
        // predicate hard-wired to `false` would satisfy all of them.
        expect(createsTenantMembership('export const x = 1;')).toBe(false);
        expect(createsTenantMembership('')).toBe(false);
    });
});
