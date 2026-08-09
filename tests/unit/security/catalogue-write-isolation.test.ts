/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock
 * pattern; per-line typing has poor cost/benefit ratio. */

/**
 * No tenant can write the GLOBAL framework catalogue.
 *
 * `Framework` and `FrameworkRequirement` carry no `tenantId`, and correctly so
 * — a shared catalogue with a per-tenant link table is the right architecture
 * for standards every farm is audited against. The defect was that
 * tenant-scoped routes could WRITE to it, under gates that resolve from Role
 * and are therefore held by the OWNER or ADMIN of every farm on the platform.
 *
 * Two paths, both reachable from an ordinary tenant session:
 *
 *   - `upsertRequirements` gated on `assertCanInstallFrameworkPack`, and with
 *     `deprecateMissing: true` ran `updateMany` over the WHOLE global
 *     `frameworkId` stamping `deprecatedAt`. Deprecated requirements are
 *     excluded from coverage and from the Statement of Applicability, so one
 *     farm silently zeroed every other farm's coverage, readiness and SoA.
 *     There was no audit row anywhere in the file, so the most destructive
 *     operation in the catalogue left no trace of who ran it.
 *   - `createScheme` gated on per-tenant `assertCanAdmin` and then wrote into
 *     the global table that `listSchemes` reads with NO tenant filter — one
 *     farm's scheme name, description and every requirement title appeared on
 *     every other farm's page, and the globally-unique key was burned
 *     platform-wide with no delete path to recover it.
 *
 * These tests execute the gate. The companion structural ratchet
 * (`tests/guards/catalogue-write-gate.test.ts`) proves no future caller
 * reintroduces a weaker one.
 */

const mockPrisma = {
    framework: { findFirst: jest.fn(), create: jest.fn() },
    frameworkRequirement: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        createMany: jest.fn(),
        updateMany: jest.fn(),
    },
} as any;

jest.mock('@/lib/prisma', () => ({ prisma: mockPrisma }));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string) => s),
}));
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_c: any, fn: (db: any) => any) => fn(mockPrisma)),
}));

import { upsertRequirements } from '@/app-layer/usecases/framework/fixtures';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../../helpers/make-context';

const PLATFORM_SLUG = 'platform-support';

/** A context for an ordinary farm — an OWNER, the highest tenant role. */
function farmOwner() {
    return makeRequestContext('OWNER', { tenantSlug: 'sunny-acres' });
}

/** A context for an admin inside the designated platform tenant. */
function platformAdmin() {
    return makeRequestContext('ADMIN', { tenantSlug: PLATFORM_SLUG });
}

beforeEach(() => {
    jest.clearAllMocks();
    process.env.PLATFORM_TENANT_SLUG = PLATFORM_SLUG;
    mockPrisma.framework.findFirst.mockResolvedValue({ id: 'fw-1', key: 'GG' });
    mockPrisma.frameworkRequirement.findUnique.mockResolvedValue(null);
    mockPrisma.frameworkRequirement.create.mockResolvedValue({ id: 'r-1' });
    mockPrisma.frameworkRequirement.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.frameworkRequirement.createMany.mockResolvedValue({ count: 1 });
    mockPrisma.framework.create.mockResolvedValue({ id: 'fw-new', key: 'CUSTOM' });
});

const FIXTURE = [{ code: 'CB.7.1', title: 'Application records' }];

describe('upsertRequirements — the requirement wipe', () => {
    it('refuses an ordinary farm OWNER', async () => {
        await expect(upsertRequirements(farmOwner(), 'GG', FIXTURE)).rejects.toThrow();
        expect(mockPrisma.frameworkRequirement.create).not.toHaveBeenCalled();
        expect(mockPrisma.frameworkRequirement.updateMany).not.toHaveBeenCalled();
    });

    it('refuses BEFORE touching the catalogue, not after', async () => {
        // The gate has to precede the read too — a 403 that still tells the
        // caller whether a framework key exists is an enumeration oracle over
        // the catalogue.
        await expect(upsertRequirements(farmOwner(), 'GG', FIXTURE)).rejects.toThrow();
        expect(mockPrisma.framework.findFirst).not.toHaveBeenCalled();
    });

    it('404s rather than 403s outside the platform tenant', async () => {
        // A 403 confirms the surface is there to be found. From an unrelated
        // farm's perspective the catalogue console genuinely does not exist.
        await expect(upsertRequirements(farmOwner(), 'GG', FIXTURE)).rejects.toThrow(
            /not found/i,
        );
    });

    it('refuses even a farm OWNER when no platform tenant is configured', async () => {
        // Fail closed: an unset env var must LOSE the feature, never open it
        // to everyone.
        delete process.env.PLATFORM_TENANT_SLUG;
        await expect(upsertRequirements(platformAdmin(), 'GG', FIXTURE)).rejects.toThrow();
    });

    it('allows a platform-tenant admin', async () => {
        const res = await upsertRequirements(platformAdmin(), 'GG', FIXTURE);
        expect(res).toMatchObject({ frameworkKey: 'GG', created: 1 });
    });

    it('audits the mutation, naming how many requirements it deprecated', async () => {
        // There was no audit anywhere in fixtures.ts. `deprecated` is the
        // number that matters: it counts the control points that just stopped
        // counting for EVERY tenant.
        mockPrisma.frameworkRequirement.updateMany.mockResolvedValue({ count: 6 });
        await upsertRequirements(platformAdmin(), 'GG', FIXTURE, { deprecateMissing: true });

        expect(logEvent).toHaveBeenCalledTimes(1);
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('FRAMEWORK_REQUIREMENTS_UPSERTED');
        expect(payload.entityType).toBe('Framework');
        expect(payload.detailsJson.after).toMatchObject({
            frameworkKey: 'GG',
            deprecated: 6,
            deprecateMissing: true,
        });
    });

    it('audits a non-destructive run too', async () => {
        await upsertRequirements(platformAdmin(), 'GG', FIXTURE);
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.detailsJson.after.deprecated).toBe(0);
        expect(payload.detailsJson.after.deprecateMissing).toBe(false);
    });
});

