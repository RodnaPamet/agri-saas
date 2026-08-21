/**
 * Unit tests — password change / reset (`@/lib/auth/password-management`).
 *
 * Prisma, the mailer, the audit emitters, and the bcrypt helpers are
 * mocked; these tests exercise the flow logic:
 *   - enumeration-safe no-ops (unknown / OAuth-only email)
 *   - the SHA-256-at-rest token model
 *   - single-use token claim (invalid / expired / race-lost)
 *   - session revocation on every success path
 */

// ─── Mocks (declared before the SUT import) ─────────────────────────

const mockPrisma = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    passwordResetToken: {
        findUnique: jest.fn(),
        create: jest.fn(),
        deleteMany: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
    },
    userSession: { updateMany: jest.fn() },
    $transaction: jest.fn(),
};

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('@/lib/mailer', () => ({ sendEmail: jest.fn() }));
jest.mock('@/lib/auth/security-events', () => ({
    recordPasswordResetRequested: jest.fn(),
    recordPasswordResetCompleted: jest.fn(),
    recordPasswordChanged: jest.fn(),
}));
jest.mock('@/lib/security/encryption', () => ({
    hashForLookup: (s: string) => `lookup:${s}`,
}));
jest.mock('@/lib/auth/passwords', () => ({
    hashPassword: jest.fn(async () => 'NEW_BCRYPT_HASH'),
    verifyPassword: jest.fn(),
}));

import {
    issuePasswordReset,
    consumePasswordReset,
    changePassword,
} from '@/lib/auth/password-management';
import { sendEmail } from '@/lib/mailer';
import {
    recordPasswordResetRequested,
    recordPasswordResetCompleted,
    recordPasswordChanged,
} from '@/lib/auth/security-events';
import { hashPassword, verifyPassword } from '@/lib/auth/passwords';

const mockSendEmail = sendEmail as jest.Mock;
const mockVerifyPassword = verifyPassword as jest.Mock;

beforeEach(() => {
    jest.clearAllMocks();
    // Array-form $transaction → resolve every queued op.
    mockPrisma.$transaction.mockImplementation((ops: Promise<unknown>[]) =>
        Promise.all(ops),
    );
});

// ─── issuePasswordReset ─────────────────────────────────────────────

describe('issuePasswordReset', () => {
    it('is a silent no-op for an unknown email — no token, no mail', async () => {
        mockPrisma.user.findUnique.mockResolvedValue(null);

        await expect(issuePasswordReset('nobody@example.com')).resolves.toBeUndefined();

        expect(mockPrisma.passwordResetToken.create).not.toHaveBeenCalled();
        expect(mockSendEmail).not.toHaveBeenCalled();
        expect(recordPasswordResetRequested).not.toHaveBeenCalled();
    });

    it('is a silent no-op for an OAuth-only account (no passwordHash)', async () => {
        mockPrisma.user.findUnique.mockResolvedValue({
            id: 'u1',
            email: 'oauth@example.com',
            passwordHash: null,
        });

        await issuePasswordReset('oauth@example.com');

        expect(mockPrisma.passwordResetToken.create).not.toHaveBeenCalled();
        expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('mints a hashed token and emails a reset link for a credentials user', async () => {
        mockPrisma.user.findUnique.mockResolvedValue({
            id: 'u1',
            email: 'real@example.com',
            passwordHash: '$2b$12$abcdefghijklmnopqrstuv',
            // Pinned so the `/reset/i` subject assertion below stays about the
            // TOKEN, not the copy. Since #694 the body is written in the
            // recipient's language, and a user row with no `uiLanguage` falls
            // back to `bg` (the column default) — so an unpinned row here
            // yields "Смяна на паролата" and this test would be asserting
            // localisation by accident. The locale behaviour has its own
            // suite: tests/unit/auth-email-locale.test.ts.
            uiLanguage: 'en',
        });
        mockPrisma.passwordResetToken.deleteMany.mockResolvedValue({ count: 0 });
        mockPrisma.passwordResetToken.create.mockResolvedValue({});

        await issuePasswordReset('real@example.com', { requestId: 'req-1' });

        // Token row created with a SHA-256 hash (64 hex chars), not raw.
        const createArg = mockPrisma.passwordResetToken.create.mock.calls[0][0];
        expect(createArg.data.userId).toBe('u1');
        expect(createArg.data.tokenHash).toMatch(/^[a-f0-9]{64}$/);
        expect(createArg.data.expiresAt).toBeInstanceOf(Date);
        expect(createArg.data.expiresAt.getTime()).toBeGreaterThan(Date.now());

        // The emailed link carries the RAW token — which must NOT equal
        // the value persisted to the DB (the DB stores only the hash).
        expect(mockSendEmail).toHaveBeenCalledTimes(1);
        const mail = mockSendEmail.mock.calls[0][0];
        expect(mail.to).toBe('real@example.com');
        expect(mail.subject).toMatch(/reset/i);
        const tokenInLink = /reset-password\?token=([a-f0-9]+)/.exec(mail.text);
        expect(tokenInLink).not.toBeNull();
        expect(tokenInLink![1]).not.toBe(createArg.data.tokenHash);

        expect(recordPasswordResetRequested).toHaveBeenCalledTimes(1);
    });

    it('swallows a mailer failure — the token row is already committed', async () => {
        mockPrisma.user.findUnique.mockResolvedValue({
            id: 'u1',
            email: 'real@example.com',
            passwordHash: '$2b$12$abcdefghijklmnopqrstuv',
        });
        mockPrisma.passwordResetToken.deleteMany.mockResolvedValue({ count: 0 });
        mockPrisma.passwordResetToken.create.mockResolvedValue({});
        mockSendEmail.mockRejectedValue(new Error('smtp down'));

        await expect(issuePasswordReset('real@example.com')).resolves.toBeUndefined();
        expect(mockPrisma.passwordResetToken.create).toHaveBeenCalledTimes(1);
    });
});

// ─── consumePasswordReset ───────────────────────────────────────────

describe('consumePasswordReset', () => {
    const futureToken = (over: Record<string, unknown> = {}) => ({
        id: 't1',
        userId: 'u1',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        user: { id: 'u1', email: 'real@example.com' },
        ...over,
    });

    it('rejects an empty token without touching the DB', async () => {
        const res = await consumePasswordReset('', 'NewPassw0rd!');
        expect(res).toEqual({ ok: false, reason: 'invalid' });
        expect(mockPrisma.passwordResetToken.findUnique).not.toHaveBeenCalled();
    });

    it('rejects an unknown token as invalid', async () => {
        mockPrisma.passwordResetToken.findUnique.mockResolvedValue(null);
        const res = await consumePasswordReset('deadbeef', 'NewPassw0rd!');
        expect(res).toEqual({ ok: false, reason: 'invalid' });
        expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects an already-used token as invalid', async () => {
        mockPrisma.passwordResetToken.findUnique.mockResolvedValue(
            futureToken({ usedAt: new Date() }),
        );
        const res = await consumePasswordReset('abc', 'NewPassw0rd!');
        expect(res).toEqual({ ok: false, reason: 'invalid' });
        expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects an expired token and burns the row', async () => {
        mockPrisma.passwordResetToken.findUnique.mockResolvedValue(
            futureToken({ expiresAt: new Date(Date.now() - 60_000) }),
        );
        mockPrisma.passwordResetToken.update.mockResolvedValue({});

        const res = await consumePasswordReset('abc', 'NewPassw0rd!');

        expect(res).toEqual({ ok: false, reason: 'expired' });
        expect(mockPrisma.passwordResetToken.update).toHaveBeenCalledWith({
            where: { id: 't1' },
            data: { usedAt: expect.any(Date) },
        });
        expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects a lost single-use claim race as invalid', async () => {
        mockPrisma.passwordResetToken.findUnique.mockResolvedValue(futureToken());
        // Claim updateMany finds 0 rows — another submit won.
        mockPrisma.passwordResetToken.updateMany.mockResolvedValueOnce({ count: 0 });

        const res = await consumePasswordReset('abc', 'NewPassw0rd!');

        expect(res).toEqual({ ok: false, reason: 'invalid' });
        expect(hashPassword).not.toHaveBeenCalled();
        expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('swaps the hash, bumps sessionVersion, and revokes sessions on success', async () => {
        mockPrisma.passwordResetToken.findUnique.mockResolvedValue(futureToken());
        mockPrisma.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });

        const res = await consumePasswordReset('abc', 'NewPassw0rd!');

        expect(res).toEqual({ ok: true, userId: 'u1' });
        expect(hashPassword).toHaveBeenCalledWith('NewPassw0rd!');
        expect(mockPrisma.user.update).toHaveBeenCalledWith({
            where: { id: 'u1' },
            data: {
                passwordHash: 'NEW_BCRYPT_HASH',
                sessionVersion: { increment: 1 },
            },
        });
        expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith({
            where: { userId: 'u1', revokedAt: null },
            data: { revokedAt: expect.any(Date), revokedReason: 'user:password-reset' },
        });
        expect(recordPasswordResetCompleted).toHaveBeenCalledTimes(1);
    });
});

// ─── changePassword ─────────────────────────────────────────────────

describe('changePassword', () => {
    it('returns no_password when the user does not exist', async () => {
        mockPrisma.user.findUnique.mockResolvedValue(null);
        const res = await changePassword('u1', 'old', 'NewPassw0rd!');
        expect(res).toEqual({ ok: false, reason: 'no_password' });
    });

    it('returns no_password for an OAuth-only account', async () => {
        mockPrisma.user.findUnique.mockResolvedValue({
            id: 'u1',
            email: 'oauth@example.com',
            passwordHash: null,
        });
        const res = await changePassword('u1', 'old', 'NewPassw0rd!');
        expect(res).toEqual({ ok: false, reason: 'no_password' });
        expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('returns wrong_password when the current password does not verify', async () => {
        mockPrisma.user.findUnique.mockResolvedValue({
            id: 'u1',
            email: 'real@example.com',
            passwordHash: '$2b$12$abcdefghijklmnopqrstuv',
        });
        mockVerifyPassword.mockResolvedValue(false);

        const res = await changePassword('u1', 'wrong', 'NewPassw0rd!');

        expect(res).toEqual({ ok: false, reason: 'wrong_password' });
        expect(hashPassword).not.toHaveBeenCalled();
        expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('swaps the hash, bumps sessionVersion, and revokes sessions on success', async () => {
        mockPrisma.user.findUnique.mockResolvedValue({
            id: 'u1',
            email: 'real@example.com',
            passwordHash: '$2b$12$abcdefghijklmnopqrstuv',
        });
        mockVerifyPassword.mockResolvedValue(true);

        const res = await changePassword('u1', 'rightOld', 'NewPassw0rd!');

        expect(res).toEqual({ ok: true });
        expect(hashPassword).toHaveBeenCalledWith('NewPassw0rd!');
        expect(mockPrisma.user.update).toHaveBeenCalledWith({
            where: { id: 'u1' },
            data: {
                passwordHash: 'NEW_BCRYPT_HASH',
                sessionVersion: { increment: 1 },
            },
        });
        expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith({
            where: { userId: 'u1', revokedAt: null },
            data: { revokedAt: expect.any(Date), revokedReason: 'user:password-change' },
        });
        expect(recordPasswordChanged).toHaveBeenCalledTimes(1);
    });
});
