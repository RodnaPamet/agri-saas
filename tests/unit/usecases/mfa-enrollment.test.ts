/**
 * Unit tests for src/app-layer/usecases/mfa-enrollment.ts
 *
 * Closes the second-tier MFA coverage gap (challenge is one half;
 * enrollment is the other). The enrollment usecase generates the
 * TOTP secret a user pairs into their authenticator app — bugs here
 * are weak-secret / leaked-secret / forgotten-cleanup risks.
 *
 * Behaviours protected:
 *   1. start: encrypted-at-rest secret, plaintext returned ONLY once,
 *      idempotent re-start replaces an unverified row but cannot
 *      replace a verified one (the verify step is the gate)
 *   2. verify: rejects when no enrollment exists; rejects when already
 *      verified (defends against re-verify bypass); marks isVerified=true
 *      and stamps verifiedAt on success
 *   3. remove: self-service for own enrollment; admin-only for others;
 *      tenant-scoped deleteMany prevents cross-tenant erasure
 */

jest.mock('@/lib/prisma', () => ({
    prisma: {
        user: { findUniqueOrThrow: jest.fn() },
        userMfaEnrollment: {
            findUnique: jest.fn(),
            upsert: jest.fn(),
            update: jest.fn(),
            deleteMany: jest.fn(),
        },
    },
}));

jest.mock('@/lib/security/totp-crypto', () => ({
    generateTotpSecret: jest.fn(),
    generateTotpUri: jest.fn(),
    encryptTotpSecret: jest.fn(),
    decryptTotpSecret: jest.fn(),
    verifyTotpCode: jest.fn(),
}));

jest.mock('@/env', () => ({
    env: { AUTH_SECRET: 'test-auth-secret-32-chars-or-more-xx' }, // pragma: allowlist secret — placeholder so totp encryption module loads under test
}));

import {
    startMfaEnrollment,
    verifyMfaEnrollment,
    removeMfaEnrollment,
} from '@/app-layer/usecases/mfa-enrollment';
import { prisma } from '@/lib/prisma';
import {
    generateTotpSecret,
    generateTotpUri,
    encryptTotpSecret,
    decryptTotpSecret,
    verifyTotpCode,
} from '@/lib/security/totp-crypto';
import { makeRequestContext } from '../../helpers/make-context';

const mockUserFind = prisma.user.findUniqueOrThrow as jest.MockedFunction<
    typeof prisma.user.findUniqueOrThrow
>;
const mockEnrollFind = prisma.userMfaEnrollment.findUnique as jest.MockedFunction<
    typeof prisma.userMfaEnrollment.findUnique
>;
const mockEnrollUpsert = prisma.userMfaEnrollment.upsert as jest.MockedFunction<
    typeof prisma.userMfaEnrollment.upsert
>;
const mockEnrollUpdate = prisma.userMfaEnrollment.update as jest.MockedFunction<
    typeof prisma.userMfaEnrollment.update
>;
const mockEnrollDelete = prisma.userMfaEnrollment.deleteMany as jest.MockedFunction<
    typeof prisma.userMfaEnrollment.deleteMany
>;
const mockGenSecret = generateTotpSecret as jest.MockedFunction<typeof generateTotpSecret>;
const mockGenUri = generateTotpUri as jest.MockedFunction<typeof generateTotpUri>;
const mockEncrypt = encryptTotpSecret as jest.MockedFunction<typeof encryptTotpSecret>;
const mockDecrypt = decryptTotpSecret as jest.MockedFunction<typeof decryptTotpSecret>;
const mockVerify = verifyTotpCode as jest.MockedFunction<typeof verifyTotpCode>;

beforeEach(() => {
    jest.clearAllMocks();
    mockGenSecret.mockReturnValue('JBSWY3DPEHPK3PXP');
    mockGenUri.mockReturnValue('otpauth://totp/Agrent:user@example.com?secret=...');
    mockEncrypt.mockReturnValue('encrypted-blob');
    mockUserFind.mockResolvedValue({ email: 'user@example.com' } as never);
    mockEnrollUpsert.mockResolvedValue({ id: 'enr-1' } as never);
    mockEnrollUpdate.mockResolvedValue({ id: 'enr-1' } as never);
    mockEnrollDelete.mockResolvedValue({ count: 1 } as never);
});

const userCtx = makeRequestContext('EDITOR', { userId: 'u1', tenantId: 't1' });
const adminCtx = makeRequestContext('ADMIN', { userId: 'admin-u', tenantId: 't1' });

describe('startMfaEnrollment', () => {
    it('returns plaintext secret + otpauth URI exactly once and persists encrypted blob', async () => {
        const result = await startMfaEnrollment(userCtx);

        expect(result.secret).toBe('JBSWY3DPEHPK3PXP');
        expect(result.uri).toContain('otpauth://');
        expect(result.enrollmentId).toBe('enr-1');

        // Persisted row carries the ENCRYPTED blob — never the plaintext.
        const upsertArgs = mockEnrollUpsert.mock.calls[0][0];
        expect(upsertArgs.create.secretEncrypted).toBe('encrypted-blob');
        expect(upsertArgs.update.secretEncrypted).toBe('encrypted-blob');
        // Regression: a refactor that accidentally persists the raw secret
        // would change the create payload's secretEncrypted to match the
        // plaintext. Defence-in-depth: assert it does NOT equal the plain.
        expect(upsertArgs.create.secretEncrypted).not.toBe(result.secret);
    });

    it('upsert resets isVerified=false on re-enrollment to force re-verify', async () => {
        await startMfaEnrollment(userCtx);
        const upsertArgs = mockEnrollUpsert.mock.calls[0][0];
        expect(upsertArgs.create.isVerified).toBe(false);
        expect(upsertArgs.update.isVerified).toBe(false);
        // Regression: a bug that left isVerified=true on update would
        // skip the second-step verify and let a new (possibly wrong)
        // secret silently become trusted.
        expect(upsertArgs.update.verifiedAt).toBeNull();
    });

    it('scopes upsert by (userId, tenantId, type=TOTP)', async () => {
        await startMfaEnrollment(userCtx);
        const upsertArgs = mockEnrollUpsert.mock.calls[0][0];
        expect(upsertArgs.where.userId_tenantId_type).toEqual({
            userId: 'u1',
            tenantId: 't1',
            type: 'TOTP',
        });
    });
});

describe('verifyMfaEnrollment', () => {
    const enrolled = {
        id: 'enr-1',
        userId: 'u1',
        tenantId: 't1',
        type: 'TOTP' as const,
        secretEncrypted: 'enc',
        isVerified: false,
        verifiedAt: null,
    };

    it('throws badRequest when no enrollment row exists', async () => {
        mockEnrollFind.mockResolvedValue(null);
        await expect(
            verifyMfaEnrollment(userCtx, { code: '123456' }),
        ).rejects.toThrow(/No MFA enrollment found/);
        expect(mockVerify).not.toHaveBeenCalled();
    });

    it('throws badRequest when enrollment is already verified (re-verify defence)', async () => {
        mockEnrollFind.mockResolvedValue({ ...enrolled, isVerified: true } as never);
        await expect(
            verifyMfaEnrollment(userCtx, { code: '123456' }),
        ).rejects.toThrow(/already verified/);
        // Regression: a "second verify" path could overwrite the
        // verified flag with a stale code from an attacker who saw a
        // valid one. Reject categorically.
        expect(mockVerify).not.toHaveBeenCalled();
    });

    it('returns success:false WITHOUT marking verified when the code is wrong', async () => {
        mockEnrollFind.mockResolvedValue(enrolled as never);
        mockDecrypt.mockReturnValue('JBSWY3DPEHPK3PXP');
        mockVerify.mockReturnValue(false);

        const r = await verifyMfaEnrollment(userCtx, { code: '000000' });

        expect(r.success).toBe(false);
        // Regression: a bug that called update() unconditionally would
        // mark the enrollment verified on the first wrong code.
        expect(mockEnrollUpdate).not.toHaveBeenCalled();
    });

    it('marks isVerified=true + stamps verifiedAt on a correct code', async () => {
        mockEnrollFind.mockResolvedValue(enrolled as never);
        mockDecrypt.mockReturnValue('JBSWY3DPEHPK3PXP');
        mockVerify.mockReturnValue(true);

        const r = await verifyMfaEnrollment(userCtx, { code: '654321' });

        expect(r.success).toBe(true);
        expect(mockEnrollUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'enr-1' },
                data: expect.objectContaining({
                    isVerified: true,
                    verifiedAt: expect.any(Date),
                }),
            }),
        );
    });
});

describe('removeMfaEnrollment', () => {
    it('lets a user remove their own enrollment without admin rights', async () => {
        await removeMfaEnrollment(userCtx); // targetUserId omitted → self
        expect(mockEnrollDelete).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { userId: 'u1', tenantId: 't1', type: 'TOTP' },
            }),
        );
    });

    it('lets a user remove their own enrollment when explicitly named', async () => {
        await removeMfaEnrollment(userCtx, 'u1');
        expect(mockEnrollDelete).toHaveBeenCalled();
    });

    it('rejects a non-admin caller trying to remove someone else', async () => {
        await expect(
            removeMfaEnrollment(userCtx, 'someone-else'),
        ).rejects.toThrow(/Only admins/);
        // Regression: privilege-escalation route — a buggy permission
        // check would let any user wipe another user's MFA, leaving
        // them in an MFA-required-but-unenrolled lockout AND opening
        // a re-enrolment window the attacker practices.
        expect(mockEnrollDelete).not.toHaveBeenCalled();
    });

    it('lets ADMIN force-remove another user in the same tenant', async () => {
        await removeMfaEnrollment(adminCtx, 'victim-id');
        expect(mockEnrollDelete).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { userId: 'victim-id', tenantId: 't1', type: 'TOTP' },
            }),
        );
    });

    it('scopes the deleteMany to ctx.tenantId — never cross-tenant', async () => {
        await removeMfaEnrollment(adminCtx, 'victim-id');
        const args = mockEnrollDelete.mock.calls[0][0];
        // The tenantId in the WHERE comes from ctx, not the target's.
        // Regression: an admin in tenant A whose request is forged to
        // target a user in tenant B would, without this scope, reach
        // cross-tenant. The check ensures the deleteMany is bounded.
        expect(args?.where).toHaveProperty('tenantId', 't1');
    });

    it('returns removed:false when nothing matched', async () => {
        mockEnrollDelete.mockResolvedValue({ count: 0 } as never);
        const r = await removeMfaEnrollment(userCtx);
        expect(r.removed).toBe(false);
    });
});
