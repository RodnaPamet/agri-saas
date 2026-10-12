/**
 * A suspended account's refused invite acceptance reaches the audit chain
 * (#1656).
 *
 * ## What is being protected
 *
 * Owner ruling: record it for **platform admins only** — nothing to the
 * inviter. So the observable behaviour is narrow and easy to lose: the refusal
 * is unchanged (same code, same status, invite still pending) and the only new
 * thing is an entry nobody can read yet, because there is no moderation UI.
 *
 * That combination is exactly how a record silently stops being written. The
 * refusal keeps working, every route test stays green, and the entry is gone.
 * So this asserts the entry directly, and asserts that the refusal still
 * happens WITH it — a record that replaced the refusal would be far worse than
 * no record.
 */
const auth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => auth() }));

const isAccountSuspended = jest.fn();
jest.mock('@/lib/auth/suspension', () => ({
    ...jest.requireActual('@/lib/auth/suspension'),
    isAccountSuspended: (userId: string) => isAccountSuspended(userId),
}));

const appendPlatformAuditEntry = jest.fn();
jest.mock('@/lib/audit/platform-audit-writer', () => ({
    ...jest.requireActual('@/lib/audit/platform-audit-writer'),
    appendPlatformAuditEntry: (...a: unknown[]) => appendPlatformAuditEntry(...a),
}));

const tenantInviteFindUnique = jest.fn();
const orgInviteFindUnique = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenantInvite: { findUnique: (...a: unknown[]) => tenantInviteFindUnique(...a) },
        orgInvite: { findUnique: (...a: unknown[]) => orgInviteFindUnique(...a) },
    },
    prisma: {
        tenantInvite: { findUnique: (...a: unknown[]) => tenantInviteFindUnique(...a) },
        orgInvite: { findUnique: (...a: unknown[]) => orgInviteFindUnique(...a) },
    },
}));

const redeemInvite = jest.fn();
jest.mock('@/app-layer/usecases/tenant-invites', () => ({
    ...jest.requireActual('@/app-layer/usecases/tenant-invites'),
    redeemInvite: (...a: unknown[]) => redeemInvite(...a),
}));

import { recordSuspendedRefusal } from '@/lib/auth/suspended-refusal-audit';
import { authRefusingSuspended } from '@/lib/auth/session-gate';

const SESSION = { user: { id: 'u-sus', email: 'farmer@example.com' } };

beforeEach(() => {
    jest.clearAllMocks();
    auth.mockResolvedValue(SESSION);
    isAccountSuspended.mockResolvedValue(true);
    appendPlatformAuditEntry.mockResolvedValue({ id: 'a1' });
    tenantInviteFindUnique.mockResolvedValue({ id: 'inv-1', tenantId: 'ten-1' });
    orgInviteFindUnique.mockResolvedValue({ id: 'oinv-1', organizationId: 'org-1' });
});

describe('the gate records the refusal and still refuses (#1656)', () => {
    it('appends a moderation entry naming the invite, then throws', async () => {
        await expect(
            authRefusingSuspended({
                attempted: 'INVITE_ACCEPTANCE',
                surface: 'TENANT',
                token: 'tok-abc',
            }),
        ).rejects.toMatchObject({ status: 403, code: 'ACCOUNT_SUSPENDED' });

        expect(appendPlatformAuditEntry).toHaveBeenCalledTimes(1);
        expect(appendPlatformAuditEntry.mock.calls[0][0]).toMatchObject({
            scope: 'moderation',
            action: 'SUSPENDED_ACCOUNT_REFUSED',
            detailsJson: {
                targetUserId: 'u-sus',
                attempted: 'INVITE_ACCEPTANCE',
                surface: 'TENANT',
                inviteId: 'inv-1',
                invitedToId: 'ten-1',
            },
        });
    });

    it('records NO token — the entry must not carry a bearer capability', async () => {
        // An audit log is immutable, so a token that leaked into one could
        // never be redacted. Asserted on the serialised entry rather than on
        // named fields, so a token added under any key fails this.
        await expect(
            authRefusingSuspended({
                attempted: 'INVITE_ACCEPTANCE',
                surface: 'TENANT',
                token: 'tok-secret-xyz',
            }),
        ).rejects.toMatchObject({ status: 403 });

        const serialised = JSON.stringify(appendPlatformAuditEntry.mock.calls[0][0]);
        expect(serialised).not.toContain('tok-secret-xyz');
    });

    it('uses the ORG tables for an org invite', async () => {
        await expect(
            authRefusingSuspended({
                attempted: 'INVITE_ACCEPTANCE',
                surface: 'ORG',
                token: 'tok-org',
            }),
        ).rejects.toMatchObject({ status: 403 });

        expect(orgInviteFindUnique).toHaveBeenCalled();
        expect(tenantInviteFindUnique).not.toHaveBeenCalled();
        expect(appendPlatformAuditEntry.mock.calls[0][0]).toMatchObject({
            detailsJson: { surface: 'ORG', inviteId: 'oinv-1', invitedToId: 'org-1' },
        });
    });

    it('records an unresolvable token as a null id rather than skipping', async () => {
        // A revoked-and-deleted or bogus token matches no row. The ATTEMPT
        // still happened, and dropping the entry would lose it.
        tenantInviteFindUnique.mockResolvedValue(null);
        await expect(
            authRefusingSuspended({
                attempted: 'INVITE_ACCEPTANCE',
                surface: 'TENANT',
                token: 'tok-gone',
            }),
        ).rejects.toMatchObject({ status: 403 });

        expect(appendPlatformAuditEntry).toHaveBeenCalledTimes(1);
        expect(appendPlatformAuditEntry.mock.calls[0][0]).toMatchObject({
            detailsJson: { inviteId: null, invitedToId: null },
        });
    });

    it('still refuses when the audit append FAILS', async () => {
        // The refusal is what protects the farm. A chain write that turned a
        // correct 403 into a 500 would be a worse outcome than no record.
        appendPlatformAuditEntry.mockRejectedValue(new Error('chain down'));
        await expect(
            authRefusingSuspended({
                attempted: 'INVITE_ACCEPTANCE',
                surface: 'TENANT',
                token: 'tok-abc',
            }),
        ).rejects.toMatchObject({ status: 403, code: 'ACCOUNT_SUSPENDED' });
    });

    it('still refuses when the invite LOOKUP fails', async () => {
        tenantInviteFindUnique.mockRejectedValue(new Error('db down'));
        await expect(
            authRefusingSuspended({
                attempted: 'INVITE_ACCEPTANCE',
                surface: 'TENANT',
                token: 'tok-abc',
            }),
        ).rejects.toMatchObject({ status: 403, code: 'ACCOUNT_SUSPENDED' });
        // And the entry is still written, with what it could resolve.
        expect(appendPlatformAuditEntry).toHaveBeenCalledTimes(1);
    });

    // ── the controls ────────────────────────────────────────────────────
    it('records NOTHING for an account that is not suspended', async () => {
        isAccountSuspended.mockResolvedValue(false);
        const session = await authRefusingSuspended({
            attempted: 'INVITE_ACCEPTANCE',
            surface: 'TENANT',
            token: 'tok-abc',
        });
        expect(session).toMatchObject({ user: { id: 'u-sus' } });
        expect(appendPlatformAuditEntry).not.toHaveBeenCalled();
        expect(tenantInviteFindUnique).not.toHaveBeenCalled();
    });

    it('records nothing when no record is asked for — every other caller', async () => {
        // The gate protects ~every route. Only the invite pair records, and a
        // gate that recorded unconditionally would write an entry for each of
        // them, flooding the chain the suspension history lives in.
        await expect(authRefusingSuspended()).rejects.toMatchObject({ status: 403 });
        expect(appendPlatformAuditEntry).not.toHaveBeenCalled();
    });

    it('recordSuspendedRefusal never throws — it is called beside a refusal', async () => {
        appendPlatformAuditEntry.mockRejectedValue(new Error('chain down'));
        await expect(
            recordSuspendedRefusal('u-sus', {
                attempted: 'INVITE_ACCEPTANCE',
                surface: 'TENANT',
                token: 'tok-abc',
            }),
        ).resolves.toBeUndefined();
    });
});
