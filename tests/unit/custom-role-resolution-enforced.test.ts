/**
 * A custom role must actually NARROW a member — not merely be stored.
 *
 * WHY THIS FILE EXISTS, stated plainly so it is not "simplified" later:
 *
 * `src/lib/tenant-context.ts:120-122` is the ternary that turns a
 * `TenantCustomRole.permissionsJson` blob into `ctx.appPermissions`. Measured
 * with istanbul before this file existed, its custom-role arm had executed
 * **zero** times: running `tests/unit/tenant-context.test.ts` with
 * `--collectCoverageFrom=src/lib/tenant-context.ts` reported the branch at
 * `[0, 5]` — five passes through the enum fallback, none through the feature.
 * No `TenantCustomRole` row is created anywhere in the repo outside a jest
 * mock: not in `prisma/seed.ts`, not in `tests/helpers/`, not in any
 * integration suite.
 *
 * This one fails OPEN, which is why it is worth a file of its own.
 * `assignCustomRole` leaves `membership.role` untouched, so a member given a
 * NARROWING custom role still carries their original enum role on the row. If
 * the resolution arm is inert, they silently keep the broader enum permissions
 * — the feature inverts into a no-op precisely for the case it exists to serve.
 *
 * The tests that look like they cover this do not:
 *   - `custom-role-permissions.test.ts` and `custom-role-owner-escalation.test.ts`
 *     call `parsePermissionsJson` DIRECTLY. They prove the parser works; they
 *     cannot notice that nothing calls it. The OWNER-clamp suite's
 *     "end-to-end assertion" is a *comment* about what `requirePermission`
 *     reads.
 *   - `tenant-context.test.ts` drives the real resolver but every fixture is a
 *     plain enum role, so it only ever executes the `:` arm.
 *
 * ── The mutation this file is shaped against ──
 *
 * The obvious mutation — replacing the ternary with
 * `getPermissionsForRole(membership.role)` — is caught today by exactly one
 * substring assertion in a text guard, and by no executing test. But the
 * mutation that MATTERS defeats that guard entirely: keep the ternary and pass
 * the base role's defaults instead of the stored blob. Every substring survives
 * and the feature is just as dead.
 *
 * So the fixture is chosen so that a single assertion catches both. It narrows
 * `evidence.upload`, which is `true` for the membership's enum role (ADMIN)
 * AND `true` for the custom role's base role (EDITOR). Only the STORED JSON can
 * make it false — neither fallback can fake it.
 */

// @/env is already globally mocked via jest.config.js moduleNameMapper

const mockPrisma = {
    tenant: {
        findUnique: jest.fn(),
    },
    tenantMembership: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
    },
};

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: mockPrisma,
}));

// Deliberately NOT mocked — `parsePermissionsJson` and `getPermissionsForRole`
// are the logic under test. Mocking @/lib/permissions would make every
// assertion below vacuous.
import { getPermissionsForRole } from '@/lib/permissions';
import { resolveTenantContext } from '@/lib/tenant-context';

const TENANT = {
    id: 'tenant-1',
    slug: 'acme-corp',
    name: 'Acme Corp',
    deletedAt: null,
};

/**
 * The member's enum role is ADMIN and their custom role's base is EDITOR —
 * deliberately different, so `ctx.role` proves which one won.
 */
function membershipWithCustomRole(permissionsJson: unknown) {
    return {
        id: 'mem-1',
        tenantId: TENANT.id,
        userId: 'user-1',
        role: 'ADMIN',
        status: 'ACTIVE',
        customRoleId: 'crole-1',
        customRole: {
            id: 'crole-1',
            tenantId: TENANT.id,
            name: 'Field agronomist',
            baseRole: 'EDITOR',
            permissionsJson,
        },
    };
}

async function resolve() {
    return resolveTenantContext({ tenantSlug: TENANT.slug }, 'user-1');
}

beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.tenant.findUnique.mockResolvedValue(TENANT);
});

describe('a narrowing custom role actually narrows', () => {
    it('revokes a permission BOTH the enum role and the base role grant', async () => {
        // `evidence.upload` is true for ADMIN (the membership row's role) and
        // true for EDITOR (the custom role's base). Only the stored blob can
        // turn it off — so `false` here is unforgeable by either fallback.
        expect(getPermissionsForRole('ADMIN').evidence.upload).toBe(true);
        expect(getPermissionsForRole('EDITOR').evidence.upload).toBe(true);

        mockPrisma.tenantMembership.findUnique.mockResolvedValue(
            membershipWithCustomRole({ evidence: { upload: false } }),
        );

        const ctx = await resolve();

        expect(ctx.appPermissions.evidence.upload).toBe(false);
    });

    it('merges over the BASE role, so unlisted permissions are inherited not dropped', async () => {
        // `parsePermissionsJson` seeds from the base role's defaults, so a blob
        // naming one action must not blank the rest of its domain. A REPLACE
        // implementation would leave `view` undefined here.
        mockPrisma.tenantMembership.findUnique.mockResolvedValue(
            membershipWithCustomRole({ evidence: { upload: false } }),
        );

        const ctx = await resolve();

        expect(ctx.appPermissions.evidence.view).toBe(true);
        expect(ctx.appPermissions.evidence.download).toBe(true);
    });

    it('takes defaults from the BASE role, not the membership row role', async () => {
        // EDITOR has admin.manage false; ADMIN has it true. The membership row
        // still says ADMIN, so this is the assertion that fails the moment
        // resolution falls back to `getPermissionsForRole(membership.role)`.
        expect(getPermissionsForRole('ADMIN').admin.manage).toBe(true);
        expect(getPermissionsForRole('EDITOR').admin.manage).toBe(false);

        mockPrisma.tenantMembership.findUnique.mockResolvedValue(
            membershipWithCustomRole({ evidence: { upload: false } }),
        );

        const ctx = await resolve();

        expect(ctx.appPermissions.admin.manage).toBe(false);
    });

    it('reports the base role as the effective role', async () => {
        mockPrisma.tenantMembership.findUnique.mockResolvedValue(
            membershipWithCustomRole({ evidence: { upload: false } }),
        );

        const ctx = await resolve();

        expect(ctx.role).toBe('EDITOR');
        expect(ctx.customRole).not.toBeNull();
    });
});

describe('a custom role cannot widen past its clamp', () => {
    it('OWNER-only keys stay false however the blob is written', async () => {
        // The read-time half of the escalation guard, asserted through the REAL
        // resolution path rather than by calling the parser directly — which is
        // all the existing owner-escalation suite does.
        mockPrisma.tenantMembership.findUnique.mockResolvedValue(
            membershipWithCustomRole({
                admin: { tenant_lifecycle: true, owner_management: true, manage: true },
            }),
        );

        const ctx = await resolve();

        expect(ctx.appPermissions.admin.tenant_lifecycle).toBe(false);
        expect(ctx.appPermissions.admin.owner_management).toBe(false);
        // Non-OWNER keys in the same blob still apply — the clamp is targeted,
        // not a blanket rejection of the whole domain.
        expect(ctx.appPermissions.admin.manage).toBe(true);
    });
});

describe('the relation the resolution depends on is actually requested', () => {
    it('hydrates customRole in the membership query', async () => {
        // Deleting `include: { customRole: true }` is the sneakiest form of
        // this defect: the ternary stays textually intact, `membership.customRole`
        // is undefined at runtime, the else arm is taken silently, and the
        // fail-open is identical. A mocked prisma cannot notice that on its own
        // — it returns whatever the fixture says regardless of the include — so
        // the query shape is asserted directly.
        mockPrisma.tenantMembership.findUnique.mockResolvedValue(
            membershipWithCustomRole({ evidence: { upload: false } }),
        );

        await resolve();

        expect(mockPrisma.tenantMembership.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({ include: { customRole: true } }),
        );
    });
});

describe('the enum path is untouched — this must not narrow everyone', () => {
    it('a membership with no custom role resolves from its enum role', async () => {
        // The control. Without it, a mutation that always narrowed would look
        // like a pass, and the feature would break the 99% of members who have
        // no custom role at all.
        mockPrisma.tenantMembership.findUnique.mockResolvedValue({
            id: 'mem-2',
            tenantId: TENANT.id,
            userId: 'user-1',
            role: 'ADMIN',
            status: 'ACTIVE',
            customRoleId: null,
            customRole: null,
        });

        const ctx = await resolve();

        expect(ctx.role).toBe('ADMIN');
        expect(ctx.appPermissions).toEqual(getPermissionsForRole('ADMIN'));
    });
});
