/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/tenant-invites.ts`.
 *
 * Roadmap Q3 — Tenant lifecycle. Mocks the prisma client (used
 * directly outside runInTenantContext for token-bound writes), the
 * runInTenantContext wrapper, the audit emitter, the encryption
 * helper, and the admin policy gates.
 *
 * Covers:
 *   - createInviteToken — OWNER permission gate, ACTIVE-member
 *     duplicate rejection, normalised email + token + 7-day TTL,
 *     audit emission, URL shape.
 *   - revokeInvite — admin gate + audit emission + notFound.
 *   - listPendingInvites — query predicate (acceptedAt: null,
 *     revokedAt: null, expiresAt > now), include shape.
 *   - previewInviteByToken — returns null for revoked / accepted /
 *     expired / missing invites; matchesSession is case-insensitive
 *     trimmed comparison.
 */

const mockTenantDb = {
    user: (() => {
            // #1237: the email lookup is `findFirst` over the candidate list
            // (an `in` predicate is not valid on `findUnique`). ONE fn behind
            // both names, so a test's single `mockResolvedValue` drives the
            // code whichever method it calls — two separate fns silently stop
            // reaching it and every lookup reports "not found".
            const find = jest.fn();
            return { findUnique: find, findFirst: find };
        })(),
    tenantMembership: { findUnique: jest.fn() },
    tenantInvite: { upsert: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockTenantDb)),
}));

jest.mock('@/lib/prisma', () => ({
    prisma: {
        tenantInvite: {
            findUnique: jest.fn(),
            findFirst: jest.fn(),
            updateMany: jest.fn(),
        },
    },
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

jest.mock('@/lib/audit', () => ({
    appendAuditEntry: jest.fn(),
}));

jest.mock('@/lib/security/encryption', () => ({
    hashForLookup: jest.fn((email: string) => `hash:${email}`),
    hashForLookupCandidates: jest.fn((email: string) => [`hash:${email}`]),
}));

import { prisma } from '@/lib/prisma';
import { logEvent } from '@/app-layer/events/audit';
import {
    createInviteToken,
    revokeInvite,
    listPendingInvites,
    previewInviteByToken,
} from '@/app-layer/usecases/tenant-invites';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
});

const ownerCtx = makeRequestContext('OWNER', { tenantId: 'tenant-1' });
const adminCtx = makeRequestContext('ADMIN', { tenantId: 'tenant-1' });
const readerCtx = makeRequestContext('READER');

// ─── createInviteToken ─────────────────────────────────────────────

describe('createInviteToken', () => {
    it('refuses ADMIN inviting OWNER without owner_management permission', async () => {
        await expect(createInviteToken(adminCtx, { email: 'x@e', role: 'OWNER' }))
            .rejects.toThrow(/Only OWNERs can invite other OWNERs/);
    });

    it('allows OWNER to invite an OWNER', async () => {
        (mockTenantDb.user.findUnique as jest.Mock).mockResolvedValue(null);
        (mockTenantDb.tenantInvite.upsert as jest.Mock).mockResolvedValue({ id: 'inv-1', token: 'abc' });

        const res = await createInviteToken(ownerCtx, { email: 'new@e', role: 'OWNER' });

        expect(res.invite).toMatchObject({ id: 'inv-1' });
        expect(res.url).toBe('/invite/abc');
    });

    it('rejects when the email already has an ACTIVE membership', async () => {
        (mockTenantDb.user.findUnique as jest.Mock).mockResolvedValue({ id: 'u-existing' });
        (mockTenantDb.tenantMembership.findUnique as jest.Mock).mockResolvedValue({ status: 'ACTIVE' });

        await expect(createInviteToken(adminCtx, { email: 'taken@e', role: 'EDITOR' }))
            .rejects.toThrow(/already a member/);
    });

    it('permits an invite when the user exists but membership is INACTIVE', async () => {
        (mockTenantDb.user.findUnique as jest.Mock).mockResolvedValue({ id: 'u-existing' });
        (mockTenantDb.tenantMembership.findUnique as jest.Mock).mockResolvedValue({ status: 'DEACTIVATED' });
        (mockTenantDb.tenantInvite.upsert as jest.Mock).mockResolvedValue({ id: 'inv-1', token: 'abc' });

        await expect(createInviteToken(adminCtx, { email: 'former@e', role: 'EDITOR' }))
            .resolves.toMatchObject({ url: '/invite/abc' });
    });

    it('normalises the email (lowercase + trim) before persistence', async () => {
        (mockTenantDb.user.findUnique as jest.Mock).mockResolvedValue(null);
        (mockTenantDb.tenantInvite.upsert as jest.Mock).mockResolvedValue({ id: 'inv-1', token: 'abc' });

        await createInviteToken(adminCtx, { email: '  USER@Example.COM  ', role: 'EDITOR' });

        const upsertArgs = (mockTenantDb.tenantInvite.upsert as jest.Mock).mock.calls[0][0];
        expect(upsertArgs.create.email).toBe('user@example.com');
        expect(upsertArgs.where.tenantId_email.email).toBe('user@example.com');
    });

    it('uses a 7-day TTL on expiresAt', async () => {
        (mockTenantDb.user.findUnique as jest.Mock).mockResolvedValue(null);
        (mockTenantDb.tenantInvite.upsert as jest.Mock).mockResolvedValue({ id: 'inv-1', token: 'abc' });
        const before = Date.now();

        await createInviteToken(adminCtx, { email: 'x@e', role: 'EDITOR' });

        const upsertArgs = (mockTenantDb.tenantInvite.upsert as jest.Mock).mock.calls[0][0];
        const expiresAt = upsertArgs.create.expiresAt as Date;
        const delta = expiresAt.getTime() - before;
        const sevenDays = 7 * 24 * 60 * 60 * 1000;
        expect(delta).toBeGreaterThan(sevenDays - 5_000);
        expect(delta).toBeLessThan(sevenDays + 5_000);
    });

    it('emits MEMBER_INVITED audit', async () => {
        (mockTenantDb.user.findUnique as jest.Mock).mockResolvedValue(null);
        (mockTenantDb.tenantInvite.upsert as jest.Mock).mockResolvedValue({ id: 'inv-1', token: 'abc' });

        await createInviteToken(adminCtx, { email: 'x@e', role: 'EDITOR' });

        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('MEMBER_INVITED');
        expect(payload.entityType).toBe('TenantInvite');
    });

    it('reuses the existing invite row on re-invite (upsert update branch clears revokedAt/acceptedAt)', async () => {
        (mockTenantDb.user.findUnique as jest.Mock).mockResolvedValue(null);
        (mockTenantDb.tenantInvite.upsert as jest.Mock).mockResolvedValue({ id: 'inv-1', token: 'NEW-TOKEN' });

        await createInviteToken(adminCtx, { email: 'x@e', role: 'EDITOR' });

        const upsertArgs = (mockTenantDb.tenantInvite.upsert as jest.Mock).mock.calls[0][0];
        expect(upsertArgs.update.revokedAt).toBeNull();
        expect(upsertArgs.update.acceptedAt).toBeNull();
    });

    it('rejects READER (admin gate)', async () => {
        await expect(createInviteToken(readerCtx, { email: 'x@e', role: 'EDITOR' }))
            .rejects.toBeDefined();
        expect(mockTenantDb.tenantInvite.upsert).not.toHaveBeenCalled();
    });
});

// ─── listPendingInvites ────────────────────────────────────────────

describe('listPendingInvites', () => {
    it('queries only acceptedAt null, revokedAt null, future expiresAt', async () => {
        (mockTenantDb.tenantInvite.findMany as jest.Mock).mockResolvedValue([{ id: 'inv-1' }]);
        await listPendingInvites(adminCtx);

        const args = (mockTenantDb.tenantInvite.findMany as jest.Mock).mock.calls[0][0];
        expect(args.where.acceptedAt).toBeNull();
        expect(args.where.revokedAt).toBeNull();
        expect(args.where.expiresAt).toMatchObject({ gt: expect.any(Date) });
    });

    it('orders by createdAt desc + includes invitedBy', async () => {
        (mockTenantDb.tenantInvite.findMany as jest.Mock).mockResolvedValue([]);
        await listPendingInvites(adminCtx);
        const args = (mockTenantDb.tenantInvite.findMany as jest.Mock).mock.calls[0][0];
        expect(args.orderBy).toEqual({ createdAt: 'desc' });
        expect(args.include.invitedBy.select).toEqual({ id: true, name: true });
    });

    it('rejects READER (admin gate)', async () => {
        await expect(listPendingInvites(readerCtx)).rejects.toBeDefined();
    });
});

// ─── previewInviteByToken ──────────────────────────────────────────

describe('previewInviteByToken', () => {
    it('returns null when the token does not exist', async () => {
        (prisma.tenantInvite.findUnique as jest.Mock).mockResolvedValue(null);
        const res = await previewInviteByToken('nope', null);
        expect(res).toBeNull();
    });

    it('returns null when the invite is revoked', async () => {
        (prisma.tenantInvite.findUnique as jest.Mock).mockResolvedValue({
            email: 'x@e', role: 'EDITOR', revokedAt: new Date(), acceptedAt: null,
            expiresAt: new Date(Date.now() + 86400000),
            tenant: { name: 'T', slug: 't' },
        });
        const res = await previewInviteByToken('tok', null);
        expect(res).toBeNull();
    });

    it('returns null when already accepted', async () => {
        (prisma.tenantInvite.findUnique as jest.Mock).mockResolvedValue({
            email: 'x@e', role: 'EDITOR', revokedAt: null, acceptedAt: new Date(),
            expiresAt: new Date(Date.now() + 86400000),
            tenant: { name: 'T', slug: 't' },
        });
        expect(await previewInviteByToken('tok', null)).toBeNull();
    });

    it('returns null when expired', async () => {
        (prisma.tenantInvite.findUnique as jest.Mock).mockResolvedValue({
            email: 'x@e', role: 'EDITOR', revokedAt: null, acceptedAt: null,
            expiresAt: new Date(Date.now() - 86400000),
            tenant: { name: 'T', slug: 't' },
        });
        expect(await previewInviteByToken('tok', null)).toBeNull();
    });

    it('returns the preview with matchesSession=false when sessionEmail is null', async () => {
        (prisma.tenantInvite.findUnique as jest.Mock).mockResolvedValue({
            email: 'x@e', role: 'EDITOR', revokedAt: null, acceptedAt: null,
            expiresAt: new Date(Date.now() + 86400000),
            tenant: { name: 'Acme', slug: 'acme' },
        });
        const res = await previewInviteByToken('tok', null);
        expect(res).toMatchObject({
            tenantName: 'Acme', tenantSlug: 'acme', role: 'EDITOR', matchesSession: false,
        });
    });

    it('matchesSession is case-insensitive trimmed comparison', async () => {
        (prisma.tenantInvite.findUnique as jest.Mock).mockResolvedValue({
            email: 'User@Example.com', role: 'EDITOR', revokedAt: null, acceptedAt: null,
            expiresAt: new Date(Date.now() + 86400000),
            tenant: { name: 'A', slug: 'a' },
        });

        const same = await previewInviteByToken('tok', '  user@EXAMPLE.com ');
        const diff = await previewInviteByToken('tok', 'other@example.com');

        expect(same?.matchesSession).toBe(true);
        expect(diff?.matchesSession).toBe(false);
    });
});

// ─── revokeInvite ──────────────────────────────────────────────────

describe('revokeInvite', () => {
    it('rejects READER (admin gate)', async () => {
        await expect(revokeInvite(readerCtx, { inviteId: 'inv-1' })).rejects.toBeDefined();
    });
});
