/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks + fake DB. */
/**
 * Unit tests for `src/app-layer/usecases/audit-readiness/sharing.ts` —
 * the share-link + auditor-account access-practice surface.
 *
 * Wave-3 branch coverage. Compliance-critical: a bug here either
 *   - lets a stale token through after the pack was revoked, OR
 *   - lets a DRAFT pack leak before the freeze step ran, OR
 *   - lets an auditor keep access after `revokeAuditorAccess`.
 *
 * Branch matrix covered:
 *   - generateShareLink:  pack-not-found / pack-DRAFT / happy-path
 *   - revokeShare:        share-not-found / already-revoked / happy-path
 *   - getPackByShareToken: invalid token / expired / happy-path
 *   - inviteAuditor:      upsert success (with logEvent)
 *   - grantAuditorAccess: auditor-not-found / pack-not-found /
 *                         already-has-access (caught) / happy-path
 *   - revokeAuditorAccess: deleteMany + audit
 *   - hashToken / generateShareToken: deterministic / non-deterministic
 */

const policyCalls: string[] = [];
const auditCalls: any[] = [];

jest.mock('@/app-layer/policies/audit-readiness.policies', () => ({
    assertCanSharePack: jest.fn(() => policyCalls.push('share')),
    assertCanManageAuditors: jest.fn(() => policyCalls.push('manage')),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(async (_db: any, _ctx: any, evt: any) => {
        auditCalls.push(evt);
    }),
}));

jest.mock('@/lib/security/encryption', () => ({
    hashForLookup: jest.fn((s: string) => `hash(${s})`),
}));

const tenantDb: any = {
    auditPack: { findFirst: jest.fn() },
    auditPackShare: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    auditorAccount: { upsert: jest.fn(), findFirst: jest.fn() },
    auditorPackAccess: { create: jest.fn(), deleteMany: jest.fn() },
};
const globalDb: any = {
    auditPackShare: { findFirst: jest.fn() },
};

jest.mock('@/lib/db-context', () => {
    const actual = jest.requireActual('@/lib/db-context');
    return {
        ...actual,
        runInTenantContext: jest.fn(async (_ctx: any, callback: any) => callback(tenantDb)),
        runInGlobalContext: jest.fn(async (callback: any) => callback(globalDb)),
    };
});

import {
    hashToken,
    generateShareToken,
    generateShareLink,
    revokeShare,
    getPackByShareToken,
    inviteAuditor,
    grantAuditorAccess,
    revokeAuditorAccess,
} from '@/app-layer/usecases/audit-readiness/sharing';
import {
    assertCanSharePack,
    assertCanManageAuditors,
} from '@/app-layer/policies/audit-readiness.policies';
import { makeRequestContext } from '../../helpers/make-context';

beforeEach(() => {
    policyCalls.length = 0;
    auditCalls.length = 0;
    [
        tenantDb.auditPack.findFirst,
        tenantDb.auditPackShare.create, tenantDb.auditPackShare.findFirst, tenantDb.auditPackShare.update,
        tenantDb.auditorAccount.upsert, tenantDb.auditorAccount.findFirst,
        tenantDb.auditorPackAccess.create, tenantDb.auditorPackAccess.deleteMany,
        globalDb.auditPackShare.findFirst,
        assertCanSharePack as jest.Mock,
        assertCanManageAuditors as jest.Mock,
    ].forEach((m: any) => m.mockReset && m.mockReset());
    (assertCanSharePack as jest.Mock).mockImplementation(() => policyCalls.push('share'));
    (assertCanManageAuditors as jest.Mock).mockImplementation(() => policyCalls.push('manage'));
});

const ctx = makeRequestContext('ADMIN');

// ──────────────────────────────────────────────────────────────────────
// Token primitives — deterministic hash, fresh token
// ──────────────────────────────────────────────────────────────────────
describe('hashToken / generateShareToken', () => {
    it('hashToken is deterministic SHA-256 hex (64 chars)', () => {
        const a = hashToken('abc');
        const b = hashToken('abc');
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{64}$/);
        // Different input → different hash (sanity check).
        expect(hashToken('xyz')).not.toBe(a);
    });

    it('generateShareToken produces 32 bytes of fresh entropy (64 hex chars)', () => {
        const a = generateShareToken();
        const b = generateShareToken();
        expect(a).toMatch(/^[0-9a-f]{64}$/);
        expect(a).not.toBe(b); // Probability of collision is ~ 2^-256
    });
});

// ──────────────────────────────────────────────────────────────────────
// generateShareLink — 3 branches
// ──────────────────────────────────────────────────────────────────────
describe('generateShareLink', () => {
    it('throws notFound when the pack id is foreign to the tenant', async () => {
        tenantDb.auditPack.findFirst.mockResolvedValueOnce(null);
        await expect(
            generateShareLink(ctx, 'pack-foreign'),
        ).rejects.toThrow(/audit pack not found/i);
        expect(tenantDb.auditPackShare.create).not.toHaveBeenCalled();
        expect(auditCalls).toHaveLength(0);
    });

    it('rejects with badRequest when the pack is still DRAFT (must be frozen first)', async () => {
        // A DRAFT pack is still being edited; sharing it would leak
        // in-progress, pre-attestation content. The freeze step is
        // the compliance gate.
        tenantDb.auditPack.findFirst.mockResolvedValueOnce({ id: 'p-1', status: 'DRAFT' });
        await expect(
            generateShareLink(ctx, 'p-1'),
        ).rejects.toThrow(/draft pack/i);
        expect(tenantDb.auditPackShare.create).not.toHaveBeenCalled();
        expect(auditCalls).toHaveLength(0);
    });

    it('creates the share row, fires AUDIT_PACK_SHARED, and returns { token, expiresAt }', async () => {
        tenantDb.auditPack.findFirst.mockResolvedValueOnce({ id: 'p-1', status: 'FROZEN' });
        tenantDb.auditPackShare.create.mockResolvedValueOnce({ id: 's-1' });

        const result = await generateShareLink(ctx, 'p-1', '2027-01-01T00:00:00Z');

        expect(result.token).toMatch(/^[0-9a-f]{64}$/);
        expect(result.expiresAt).toBe('2027-01-01T00:00:00Z');
        expect(policyCalls).toEqual(['share']);
        // Token stored as HASH, never raw — load-bearing for the
        // "leaked DB dump cannot replay" property.
        const createArg = tenantDb.auditPackShare.create.mock.calls[0][0];
        expect(createArg.data.tokenHash).toBe(hashToken(result.token));
        expect(createArg.data.expiresAt).toBeInstanceOf(Date);
        expect(auditCalls).toHaveLength(1);
        expect(auditCalls[0].action).toBe('AUDIT_PACK_SHARED');
    });

    it('supports null expiry (no `expiresAt` argument → DB column null)', async () => {
        tenantDb.auditPack.findFirst.mockResolvedValueOnce({ id: 'p-1', status: 'FROZEN' });
        tenantDb.auditPackShare.create.mockResolvedValueOnce({ id: 's-1' });

        const result = await generateShareLink(ctx, 'p-1');

        expect(result.expiresAt).toBeNull();
        const createArg = tenantDb.auditPackShare.create.mock.calls[0][0];
        expect(createArg.data.expiresAt).toBeNull();
    });
});

// ──────────────────────────────────────────────────────────────────────
// revokeShare — 3 branches
// ──────────────────────────────────────────────────────────────────────
describe('revokeShare', () => {
    it('throws notFound when the share id is foreign to the tenant', async () => {
        tenantDb.auditPackShare.findFirst.mockResolvedValueOnce(null);
        await expect(revokeShare(ctx, 's-foreign')).rejects.toThrow(/share not found/i);
        expect(tenantDb.auditPackShare.update).not.toHaveBeenCalled();
    });

    it('is IDEMPOTENT-rejecting: already-revoked share throws badRequest (no double-write)', async () => {
        tenantDb.auditPackShare.findFirst.mockResolvedValueOnce({
            id: 's-1', revokedAt: new Date('2026-01-01'),
        });
        await expect(revokeShare(ctx, 's-1')).rejects.toThrow(/already revoked/i);
        expect(tenantDb.auditPackShare.update).not.toHaveBeenCalled();
        expect(auditCalls).toHaveLength(0);
    });

    it('stamps revokedAt + fires AUDIT_PACK_REVOKED on the happy-path', async () => {
        tenantDb.auditPackShare.findFirst.mockResolvedValueOnce({ id: 's-1', revokedAt: null });
        tenantDb.auditPackShare.update.mockResolvedValueOnce({ id: 's-1', revokedAt: new Date() });

        const result = await revokeShare(ctx, 's-1');

        expect(result).toEqual({ revoked: true });
        expect(tenantDb.auditPackShare.update).toHaveBeenCalledWith({
            where: { id: 's-1' },
            data: { revokedAt: expect.any(Date) },
        });
        expect(auditCalls[0].action).toBe('AUDIT_PACK_REVOKED');
    });
});

// ──────────────────────────────────────────────────────────────────────
// getPackByShareToken — 3 branches, no auth (the token IS the auth)
// ──────────────────────────────────────────────────────────────────────
describe('getPackByShareToken', () => {
    it('throws notFound when the token hash matches no live share row', async () => {
        globalDb.auditPackShare.findFirst.mockResolvedValueOnce(null);
        await expect(getPackByShareToken('bogus')).rejects.toThrow(/invalid or expired/i);
    });

    it('throws forbidden when the share has expired', async () => {
        // Reaching this branch is what protects pasted-from-Slack-link
        // attacks that arrive past the configured expiry.
        globalDb.auditPackShare.findFirst.mockResolvedValueOnce({
            id: 's-1',
            expiresAt: new Date('2026-01-01T00:00:00Z'),
            revokedAt: null,
            pack: { id: 'p-1', items: [], cycle: { frameworkKey: 'iso' } },
        });
        await expect(getPackByShareToken('valid-but-expired')).rejects.toThrow(/expired/i);
    });

    it('returns { pack, cycle, items } on the happy-path', async () => {
        globalDb.auditPackShare.findFirst.mockResolvedValueOnce({
            id: 's-1',
            expiresAt: null,
            revokedAt: null,
            pack: {
                id: 'p-1',
                items: [{ id: 'i-1', sortOrder: 1 }],
                cycle: { frameworkKey: 'iso', frameworkVersion: '2022', name: 'Cycle 1' },
            },
        });

        const result = await getPackByShareToken('legit');

        expect(result.pack.id).toBe('p-1');
        expect(result.cycle.frameworkKey).toBe('iso');
        expect(result.items).toHaveLength(1);
    });

    it('queries by tokenHash AND revokedAt-null (no auth bypass via revoked share)', async () => {
        globalDb.auditPackShare.findFirst.mockResolvedValueOnce(null);
        await expect(getPackByShareToken('any')).rejects.toThrow(/invalid/i);

        const where = globalDb.auditPackShare.findFirst.mock.calls[0][0].where;
        expect(where.tokenHash).toBe(hashToken('any'));
        expect(where.revokedAt).toBeNull();
    });
});

// ──────────────────────────────────────────────────────────────────────
// inviteAuditor / grantAuditorAccess / revokeAuditorAccess
// ──────────────────────────────────────────────────────────────────────
describe('inviteAuditor', () => {
    it('upserts the auditor account (INVITED on first insert, ACTIVE on re-invite)', async () => {
        tenantDb.auditorAccount.upsert.mockResolvedValueOnce({ id: 'a-1', email: 'auditor@ex.com' });

        const result = await inviteAuditor(ctx, 'auditor@ex.com', 'Audrey');

        expect(result.id).toBe('a-1');
        expect(policyCalls).toEqual(['manage']);
        const upsertArg = tenantDb.auditorAccount.upsert.mock.calls[0][0];
        expect(upsertArg.create.status).toBe('INVITED');
        expect(upsertArg.update.status).toBe('ACTIVE');
        expect(auditCalls[0].action).toBe('AUDITOR_INVITED');
    });
});

describe('grantAuditorAccess', () => {
    it('throws notFound when the auditor is foreign to the tenant', async () => {
        tenantDb.auditorAccount.findFirst.mockResolvedValueOnce(null);
        await expect(grantAuditorAccess(ctx, 'a-foreign', 'p-1')).rejects.toThrow(/auditor not found/i);
    });

    it('throws notFound when the pack is foreign to the tenant', async () => {
        tenantDb.auditorAccount.findFirst.mockResolvedValueOnce({ id: 'a-1', email: 'a@ex.com' });
        tenantDb.auditPack.findFirst.mockResolvedValueOnce(null);
        await expect(grantAuditorAccess(ctx, 'a-1', 'p-foreign')).rejects.toThrow(/pack not found/i);
    });

    it('rethrows duplicate-access (catch-block) as a badRequest (idempotent semantics)', async () => {
        // Prisma raises P2002 on the unique tuple (tenantId,auditorId,packId).
        // The usecase translates that to badRequest("already has access")
        // so the API surface is one stable shape across the underlying
        // concurrency outcomes.
        tenantDb.auditorAccount.findFirst.mockResolvedValueOnce({ id: 'a-1', email: 'a@ex.com' });
        tenantDb.auditPack.findFirst.mockResolvedValueOnce({ id: 'p-1' });
        tenantDb.auditorPackAccess.create.mockRejectedValueOnce(
            Object.assign(new Error('unique constraint'), { code: 'P2002' }),
        );
        await expect(grantAuditorAccess(ctx, 'a-1', 'p-1')).rejects.toThrow(/already has access/i);
        expect(auditCalls).toHaveLength(0);
    });

    it('creates the access row + audit on happy-path', async () => {
        tenantDb.auditorAccount.findFirst.mockResolvedValueOnce({ id: 'a-1', email: 'a@ex.com' });
        tenantDb.auditPack.findFirst.mockResolvedValueOnce({ id: 'p-1' });
        tenantDb.auditorPackAccess.create.mockResolvedValueOnce({ id: 'ap-1' });

        const result = await grantAuditorAccess(ctx, 'a-1', 'p-1');

        expect(result).toEqual({ granted: true });
        expect(auditCalls[0].action).toBe('AUDITOR_GRANTED');
    });
});

describe('revokeAuditorAccess', () => {
    it('deletes ALL access rows for the (auditorId, packId) pair and fires AUDITOR_REVOKED', async () => {
        // Uses `deleteMany` instead of `delete`-by-id so a duplicate
        // row (shouldn't exist due to the unique tuple but the
        // resilience is cheap) gets cleaned up in the same call.
        tenantDb.auditorPackAccess.deleteMany.mockResolvedValueOnce({ count: 1 });

        const result = await revokeAuditorAccess(ctx, 'a-1', 'p-1');

        expect(result).toEqual({ revoked: true });
        expect(tenantDb.auditorPackAccess.deleteMany).toHaveBeenCalledWith({
            where: { auditorId: 'a-1', auditPackId: 'p-1' },
        });
        expect(auditCalls[0].action).toBe('AUDITOR_REVOKED');
    });

    it('still emits the audit when deleteMany matches zero rows (idempotent revoke)', async () => {
        // Revoking an already-revoked / never-granted auditor is a
        // no-op against the DB but still produces an audit row so
        // the action is traceable to the principal who attempted it.
        tenantDb.auditorPackAccess.deleteMany.mockResolvedValueOnce({ count: 0 });

        await revokeAuditorAccess(ctx, 'a-1', 'p-1');

        expect(auditCalls).toHaveLength(1);
    });
});
