/**
 * Guardrail: a member-management surface must ACCEPT an OWNER role value,
 * and the custom-role surfaces must refuse one.
 *
 * Rationale: OWNER was added in Epic 1 PR 1. A Zod schema still enumerating
 * `['ADMIN', 'EDITOR', 'AUDITOR', 'READER']` on an invite/role endpoint
 * silently rejects OWNER with a 400 instead of honouring a legitimate OWNER
 * promotion — a bug the type system cannot catch, because Zod enums are
 * runtime-only.
 *
 * ## Why half of this stopped reading the file, and what that fixed
 *
 * The member-management half used to grep each ROUTE FILE for
 * `z.enum([… 'ADMIN' …])` and assert `'OWNER'` appeared inside it. That is a
 * PROXY for the real property, and it only held while the enum lived in the
 * route. #1555 moved those bodies into shared schemas in
 * `src/lib/schemas/index.ts`, and the grep went red on two files whose
 * behaviour had not changed at all — the literal had moved, not the contract.
 *
 * So that half now PARSES. `InviteMemberSchema.safeParse({role: 'OWNER'})`
 * asserts the thing the rationale above is actually about, and it cannot be
 * fooled by where the enum is declared, by a `const` indirection, or by a
 * second enum in the same file matching the pattern first.
 *
 * It is also strictly stronger: a file could contain the right literal in a
 * schema the route never parses, and the old check would have passed. The
 * rejection control below pins the other direction, so "accepts OWNER" cannot
 * be satisfied by a schema that accepts everything.
 *
 * ## The exemption half still reads the file, deliberately
 *
 * `admin/roles` and `admin/roles/[roleId]` declare their enums inline and are
 * not part of #1555's conversion, so there is no exported schema to parse.
 * Their check is unchanged. If they are ever converted, move them across the
 * same way rather than widening the regex — the regex is the part that broke.
 *
 * Keep this in lockstep with the Prisma `Role` enum shape.
 */

import * as fs from 'fs';
import * as path from 'path';

import { InviteMemberSchema, UpdateAdminMemberSchema } from '@/lib/schemas';

const ROOT = path.resolve(__dirname, '../..');

/**
 * The member-management bodies, as the SCHEMAS their routes parse — not as
 * file paths. Each entry carries a minimal otherwise-valid payload so the
 * assertion isolates the role field.
 */
const MEMBER_MGMT_SCHEMAS: Array<{
    label: string;
    schema: { safeParse: (v: unknown) => { success: boolean } };
    valid: Record<string, unknown>;
}> = [
    {
        label: 'POST /admin/members (InviteMemberSchema)',
        schema: InviteMemberSchema,
        valid: { email: 'new.member@example.com' },
    },
    {
        label: 'PATCH /admin/members/{membershipId} (UpdateAdminMemberSchema)',
        schema: UpdateAdminMemberSchema,
        valid: {},
    },
];

const OWNER_EXEMPT_FILES: Array<{ file: string; reason: string }> = [
    {
        file: 'src/app/api/t/[tenantSlug]/admin/roles/route.ts',
        reason:
            'Custom-role baseRole. By design custom roles cannot anchor ' +
            'to OWNER — that tier is reserved for the built-in OWNER role.',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/admin/roles/[roleId]/route.ts',
        reason: 'Same rationale as the create route above.',
    },
];

const ROLE_ENUM_PATTERN = /z\.enum\(\[[^\]]*['"]ADMIN['"][^\]]*\]/;

function readFile(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('Role Zod enums include OWNER where member-management relevant', () => {
    describe.each(MEMBER_MGMT_SCHEMAS.map((s) => [s.label, s] as const))('%s', (_label, entry) => {
        it('ACCEPTS role OWNER', () => {
            expect(entry.schema.safeParse({ ...entry.valid, role: 'OWNER' }).success).toBe(true);
        });

        it('accepts the other built-in roles too — not an OWNER-only schema', () => {
            for (const role of ['ADMIN', 'EDITOR', 'AUDITOR', 'READER', 'MECHANISATOR']) {
                expect(entry.schema.safeParse({ ...entry.valid, role }).success).toBe(true);
            }
        });

        it('REFUSES a role that is not a built-in — the control', () => {
            // Without this, "accepts OWNER" is satisfied by a schema that
            // accepts any string, which is the opposite defect and just as
            // invisible.
            expect(entry.schema.safeParse({ ...entry.valid, role: 'SUPREME_LEADER' }).success).toBe(
                false,
            );
        });
    });

    it.each(OWNER_EXEMPT_FILES)(
        '%s intentionally omits OWNER from its role enum',
        ({ file }) => {
            const content = readFile(file);
            expect(content).toMatch(ROLE_ENUM_PATTERN);
            const match = content.match(ROLE_ENUM_PATTERN);
            expect(match).not.toBeNull();
            expect(match![0]).not.toMatch(/['"]OWNER['"]/);
        },
    );
});
