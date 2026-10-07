/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks. */
/**
 * Unit tests for `src/app-layer/usecases/org-tenants.ts` —
 * `createTenantUnderOrg`.
 *
 * Wave-10 / stage-3h branch coverage. The function composes a
 * Prisma transaction (tenant.create + tenant-membership OWNER +
 * tenant-onboarding) and then a best-effort post-tx
 * `provisionAllOrgAdminsToTenant`. Branches:
 *   - happy path
 *   - P2002 (unique violation on slug) → ConflictError
 *   - other Prisma error → bubble up unmodified
 *   - provisioning throws → warn-log + tenant creation still succeeds
 *   - provisioning throws non-Error → log handles String(err)
 *
 * The transaction lambda is invoked with a mocked `tx` so we can
 * assert the exact data passed to each table.
 */

const provisionCalls: any[] = [];
const warnCalls: any[] = [];
const infoCalls: any[] = [];

jest.mock('@/lib/security/tenant-keys', () => ({
    generateAndWrapDek: jest.fn(() => ({ wrapped: 'wrapped-dek-bytes' })),
}));

jest.mock('@/app-layer/usecases/org-provisioning', () => ({
    provisionAllOrgAdminsToTenant: jest.fn(async (orgId: string, tenantId: string) => {
        provisionCalls.push({ orgId, tenantId });
        return provisionResult;
    }),
}));

let provisionResult: any = { created: 0 };
let provisionShouldThrow: Error | string | null = null;

jest.mock('@/lib/observability/logger', () => ({
    logger: {
        warn: jest.fn((msg: string, fields: any) => warnCalls.push({ msg, fields })),
        info: jest.fn((msg: string, fields: any) => infoCalls.push({ msg, fields })),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

// Captured per-test — what each tx table received + what each
// returned. Reset in beforeEach.
const txCalls: any = {
    tenantCreate: jest.fn(),
    tenantMembershipCreate: jest.fn(),
    tenantOnboardingCreate: jest.fn(),
};

let txCreateShouldThrow: any = null;

jest.mock('@/lib/prisma', () => {
    const prismaMock = {
        $transaction: jest.fn(async (cb: any) => {
            const tx: any = {
                tenant: {
                    create: jest.fn(async (args: any) => {
                        if (txCreateShouldThrow) throw txCreateShouldThrow;
                        const out = { id: 't-1', name: args.data.name, slug: args.data.slug };
                        txCalls.tenantCreate(args);
                        return out;
                    }),
                },
                tenantMembership: {
                    create: jest.fn(async (args: any) => {
                        txCalls.tenantMembershipCreate(args);
                        return { id: 'tm-1' };
                    }),
                },
                tenantOnboarding: {
                    create: jest.fn(async (args: any) => {
                        txCalls.tenantOnboardingCreate(args);
                        return { id: 'to-1' };
                    }),
                },
            };
            return cb(tx);
        }),
    };
    return { __esModule: true, default: prismaMock, prisma: prismaMock };
});

// Prisma.PrismaClientKnownRequestError shape — the source uses
// `instanceof` so we expose a real class.
class FakePrismaKnown extends Error {
    code: string;
    clientVersion = '0.0.0-test';
    constructor(code: string, message = 'fake') {
        super(message);
        this.code = code;
    }
}
jest.mock('@prisma/client', () => ({
    Prisma: {
        PrismaClientKnownRequestError: FakePrismaKnown,
    },
}));

import { createTenantUnderOrg } from '@/app-layer/usecases/org-tenants';
import { provisionAllOrgAdminsToTenant } from '@/app-layer/usecases/org-provisioning';
import { ConflictError } from '@/lib/errors/types';

beforeEach(() => {
    provisionCalls.length = 0;
    warnCalls.length = 0;
    infoCalls.length = 0;
    provisionResult = { created: 0 };
    provisionShouldThrow = null;
    txCreateShouldThrow = null;
    txCalls.tenantCreate.mockClear();
    txCalls.tenantMembershipCreate.mockClear();
    txCalls.tenantOnboardingCreate.mockClear();

    (provisionAllOrgAdminsToTenant as jest.Mock).mockImplementation(
        async (orgId: string, tenantId: string) => {
            provisionCalls.push({ orgId, tenantId });
            if (provisionShouldThrow) throw provisionShouldThrow;
            return provisionResult;
        },
    );
});

function orgCtx(overrides: Partial<any> = {}): import('@/app-layer/types').OrgContext {
    return {
        requestId: 'req-1',
        userId: 'u-1',
        organizationId: 'org-1',
        orgSlug: 'acme',
        // `OrgRole` is a Prisma enum — `as const` narrows the literal,
        // satisfying the OrgContext shape without pulling in @prisma/client
        // (which is heavy + mocked in this test).
        orgRole: 'ORG_ADMIN' as never,
        permissions: {} as any,
        ...overrides,
    };
}

describe('createTenantUnderOrg — happy path', () => {
    it('creates tenant + OWNER membership + onboarding in one tx, then provisions org admins', async () => {
        provisionResult = { created: 3 };
        const out = await createTenantUnderOrg(orgCtx(), {
            name: ' New Tenant ',
            slug: ' New-Slug ',
        });
        // Name is trimmed; slug is trimmed + lower-cased BEFORE the
        // tenant row is written.
        // P3.3: the create goes through `createFarmTenant` now, which does not
        // narrow with `select` — it returns the full row, matching
        // `createTenantWithDek`'s existing contract. The data shape, which is
        // what this case is actually about, is unchanged.
        expect(txCalls.tenantCreate).toHaveBeenCalledWith({
            data: expect.objectContaining({
                name: 'New Tenant',
                slug: 'new-slug',
                organizationId: 'org-1',
                encryptedDek: 'wrapped-dek-bytes',
            }),
        });
        // OWNER membership uses the same userId from ctx.
        expect(txCalls.tenantMembershipCreate).toHaveBeenCalledWith({
            data: {
                tenantId: 't-1',
                userId: 'u-1',
                role: 'OWNER',
                status: 'ACTIVE',
            },
        });
        expect(txCalls.tenantOnboardingCreate).toHaveBeenCalledWith({
            data: { tenantId: 't-1' },
        });
        // Provisioning ran AFTER the tx, with the new tenantId.
        expect(provisionCalls).toEqual([{ orgId: 'org-1', tenantId: 't-1' }]);
        expect(out).toEqual({
            tenant: { id: 't-1', name: 'New Tenant', slug: 'new-slug' },
            provisionedAdmins: 3,
        });
    });

    it('emits a structured info log on success with the operator-visible fields', async () => {
        provisionResult = { created: 2 };
        await createTenantUnderOrg(orgCtx(), { name: 'A', slug: 'a' });
        // `createFarmTenant` logs its own line, so this filters for the one
        // under test rather than counting every info call — a bare length
        // assertion here breaks whenever anything downstream adds a log.
        const created = infoCalls.filter((c) => c.msg === 'org-tenants.created');
        expect(created).toHaveLength(1);
        expect(created[0].fields).toMatchObject({
            organizationId: 'org-1',
            tenantId: 't-1',
            slug: 'a',
            creatorUserId: 'u-1',
            provisionedAdmins: 2,
            requestId: 'req-1',
        });
    });
});

describe('createTenantUnderOrg — error translation', () => {
    it('P2002 → ConflictError with the user-facing slug message', async () => {
        txCreateShouldThrow = new FakePrismaKnown('P2002', 'unique constraint');
        await expect(
            createTenantUnderOrg(orgCtx(), { name: 'X', slug: 'taken' }),
        ).rejects.toBeInstanceOf(ConflictError);
        await expect(
            createTenantUnderOrg(orgCtx(), { name: 'X', slug: 'taken' }),
        ).rejects.toThrow(/'taken' already exists/);
        // Provisioning never runs when the tx rejected.
        expect(provisionCalls).toHaveLength(0);
    });

    it('non-P2002 PrismaKnown errors bubble up unchanged', async () => {
        const original = new FakePrismaKnown('P2025', 'no such row');
        txCreateShouldThrow = original;
        await expect(
            createTenantUnderOrg(orgCtx(), { name: 'X', slug: 'y' }),
        ).rejects.toBe(original);
        expect(provisionCalls).toHaveLength(0);
    });

    it('generic Error from the tx bubbles up unchanged', async () => {
        const original = new Error('db unreachable');
        txCreateShouldThrow = original;
        await expect(
            createTenantUnderOrg(orgCtx(), { name: 'X', slug: 'y' }),
        ).rejects.toBe(original);
        expect(provisionCalls).toHaveLength(0);
    });
});

describe('createTenantUnderOrg — best-effort provisioning', () => {
    it('provisioning Error throws but tenant creation still succeeds + warn log emitted', async () => {
        provisionShouldThrow = new Error('provisioner down');
        const out = await createTenantUnderOrg(orgCtx(), { name: 'X', slug: 'y' });
        // Result still carries the created tenant; provisionedAdmins
        // defaults to 0 because the count was never set.
        expect(out.tenant.id).toBe('t-1');
        expect(out.provisionedAdmins).toBe(0);
        expect(warnCalls).toHaveLength(1);
        expect(warnCalls[0].msg).toBe('org-tenants.provision_after_create_failed');
        expect(warnCalls[0].fields.error).toContain('provisioner down');
    });

    it('provisioning throws a non-Error → warn log captures String(err)', async () => {
        provisionShouldThrow = 'not an Error' as any;
        const out = await createTenantUnderOrg(orgCtx(), { name: 'X', slug: 'y' });
        expect(out.tenant.id).toBe('t-1');
        expect(warnCalls[0].fields.error).toBe('not an Error');
    });

    it('successful tx + provisioned=0 still emits the structured info log', async () => {
        provisionResult = { created: 0 };
        await createTenantUnderOrg(orgCtx(), { name: 'X', slug: 'y' });
        // Index 0 is no longer this usecase's log — `createFarmTenant` emits
        // one first. Selecting by message rather than by position is what
        // stops the next added log line breaking this again.
        const zeroProvisioned = infoCalls.find((c) => c.msg === 'org-tenants.created');
        expect(zeroProvisioned?.fields.provisionedAdmins).toBe(0);
    });
});
