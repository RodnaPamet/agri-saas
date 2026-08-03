/**
 * The credentials gate on verified-email invite provisioning.
 *
 * `redeemPendingInvitesByEmail` turns "there is a pending invite for
 * this address" into a tenant membership, with no token involved. That
 * is only safe when the address has been verified by an identity
 * provider. The credentials provider's email is SELF-ASSERTED — anyone
 * can register claiming any address — so honouring an invite there
 * would hand a tenant to whoever guessed an invited email.
 *
 * `redeemPendingInvites` therefore takes `emailVerifiedByIdp` and calls
 * the email path only when it is true. These tests execute that branch
 * rather than asserting on the source text, because the failure mode is
 * silent: get it wrong and everything still "works", it just also lets
 * an attacker in.
 *
 * The companion integration tests (invite-redemption-by-email) cover
 * what the usecase does once it IS authorised.
 */

const userFindUnique = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
    },
}));

jest.mock('@/lib/security/encryption', () => ({
    __esModule: true,
    hashForLookup: (v: string) => `hash:${v}`,
}));

const warn = jest.fn();
const info = jest.fn();
jest.mock('@/lib/observability/edge-logger', () => ({
    __esModule: true,
    edgeLogger: { warn: (...a: unknown[]) => warn(...a), info: (...a: unknown[]) => info(...a) },
}));

const redeemInvite = jest.fn();
const redeemPendingInvitesByEmail = jest.fn();
jest.mock('@/app-layer/usecases/tenant-invites', () => ({
    __esModule: true,
    redeemInvite: (...a: unknown[]) => redeemInvite(...a),
    redeemPendingInvitesByEmail: (...a: unknown[]) => redeemPendingInvitesByEmail(...a),
}));

const redeemOrgInvite = jest.fn();
jest.mock('@/app-layer/usecases/org-invites', () => ({
    __esModule: true,
    redeemOrgInvite: (...a: unknown[]) => redeemOrgInvite(...a),
}));

import { redeemPendingInvites } from '@/lib/auth/invite-redemption';

const EMAIL = 'invitee@example.com';

beforeEach(() => {
    jest.clearAllMocks();
    userFindUnique.mockResolvedValue({ id: 'user-1' });
    redeemPendingInvitesByEmail.mockResolvedValue([]);
});

describe('redeemPendingInvites — verified-email gate', () => {
    it('SECURITY: credentials sign-in never provisions from a pending invite', async () => {
        // A self-asserted email must not satisfy an invite. If this
        // regresses, anyone who can guess an invited address can
        // register with it and inherit the tenant + role.
        await redeemPendingInvites({
            userEmail: EMAIL,
            tenantToken: null,
            orgToken: null,
            emailVerifiedByIdp: false,
        });

        expect(redeemPendingInvitesByEmail).not.toHaveBeenCalled();
    });

    it('SECURITY: credentials sign-in WITH a token still only redeems that token', async () => {
        // The token path is independently safe (it email-binds), so it
        // stays available to credentials users — but it must not drag
        // the address-matched path along with it.
        await redeemPendingInvites({
            userEmail: EMAIL,
            tenantToken: 'tok-abc',
            orgToken: null,
            emailVerifiedByIdp: false,
        });

        expect(redeemInvite).toHaveBeenCalledWith(
            expect.objectContaining({ token: 'tok-abc', userEmail: EMAIL }),
        );
        expect(redeemPendingInvitesByEmail).not.toHaveBeenCalled();
    });

    it('OAuth sign-in provisions from a pending invite with NO token present', async () => {
        // This is the whole point: the emailed link is optional.
        await redeemPendingInvites({
            userEmail: EMAIL,
            tenantToken: null,
            orgToken: null,
            emailVerifiedByIdp: true,
        });

        expect(redeemPendingInvitesByEmail).toHaveBeenCalledWith({
            userId: 'user-1',
            userEmail: EMAIL,
        });
    });

    it('does not even look up the user when there is nothing to do', async () => {
        // No token and no verified email — the common credentials
        // sign-in. Must stay a pure no-op on the hot path.
        await redeemPendingInvites({
            userEmail: EMAIL,
            tenantToken: null,
            orgToken: null,
            emailVerifiedByIdp: false,
        });

        expect(userFindUnique).not.toHaveBeenCalled();
    });

    it('no user row yet ⇒ no provisioning attempt', async () => {
        userFindUnique.mockResolvedValue(null);

        await redeemPendingInvites({
            userEmail: EMAIL,
            tenantToken: null,
            orgToken: null,
            emailVerifiedByIdp: true,
        });

        expect(redeemPendingInvitesByEmail).not.toHaveBeenCalled();
    });

    it('a provisioning failure is swallowed — sign-in must never break', async () => {
        redeemPendingInvitesByEmail.mockRejectedValue(new Error('db down'));

        await expect(
            redeemPendingInvites({
                userEmail: EMAIL,
                tenantToken: null,
                orgToken: null,
                emailVerifiedByIdp: true,
            }),
        ).resolves.toBeUndefined();

        expect(warn).toHaveBeenCalledWith(
            'signIn: verified-email invite provisioning failed',
            expect.objectContaining({ userId: 'user-1' }),
        );
    });

    it('logs only when a membership was actually provisioned', async () => {
        redeemPendingInvitesByEmail.mockResolvedValue([]);
        await redeemPendingInvites({
            userEmail: EMAIL,
            tenantToken: null,
            orgToken: null,
            emailVerifiedByIdp: true,
        });
        expect(info).not.toHaveBeenCalled();

        redeemPendingInvitesByEmail.mockResolvedValue([{ tenantId: 't1', slug: 's', role: 'EDITOR' }]);
        await redeemPendingInvites({
            userEmail: EMAIL,
            tenantToken: null,
            orgToken: null,
            emailVerifiedByIdp: true,
        });
        expect(info).toHaveBeenCalledWith(
            'signIn: provisioned membership from pending invite',
            expect.objectContaining({ tenantCount: 1 }),
        );
    });
});
