/**
 * Unit test — sendInviteEmail.
 *
 * Invites previously minted a URL but never emailed it. This locks the
 * send contract: the acceptance URL + recipient reach the mailer, and
 * delivery is fail-open (a mailer outage returns { sent: false }, never
 * throws — invite creation must not fail on a mail problem).
 */

const sendEmailMock = jest.fn();
// Stand-in for ConsoleEmailProvider so the prod "no SMTP → console sink"
// branch can be exercised via getEmailProvider() + instanceof.
class MockConsoleEmailProvider {}
let mockActiveProvider: object = new MockConsoleEmailProvider();

jest.mock('@/lib/mailer', () => ({
    sendEmail: (...a: unknown[]) => sendEmailMock(...a),
    ConsoleEmailProvider: MockConsoleEmailProvider,
    getEmailProvider: () => mockActiveProvider,
}));

import { sendInviteEmail } from '@/lib/email/invite-email';

const baseParams = {
    to: 'invitee@example.com',
    acceptUrl: 'https://app.example.io/invite/org/tok123',
    kind: 'organization' as const,
    spaceName: 'acme-org',
    roleLabel: 'Org admin',
    invitedByName: 'Dana Admin',
    expiresAt: new Date('2026-06-10T00:00:00Z'),
    now: new Date('2026-06-03T00:00:00Z'),
    // Pinned: since #722 the invite is written in the INVITER's language, and
    // an unpinned fixture would take the recipient fallback ('bg') and fail
    // every English assertion below while the feature works correctly. The
    // localisation itself is covered by `invite-email-locale.test.ts`.
    locale: 'en' as const,
};

describe('sendInviteEmail', () => {
    beforeEach(() => sendEmailMock.mockReset());

    it('sends to the recipient with the acceptance URL in the body', async () => {
        sendEmailMock.mockResolvedValue(undefined);
        const res = await sendInviteEmail(baseParams);

        expect(res).toEqual({ sent: true });
        expect(sendEmailMock).toHaveBeenCalledTimes(1);
        const msg = sendEmailMock.mock.calls[0][0];
        expect(msg.to).toBe('invitee@example.com');
        expect(msg.subject).toContain('acme-org');
        expect(msg.text).toContain('https://app.example.io/invite/org/tok123');
        expect(msg.html).toContain('https://app.example.io/invite/org/tok123');
        // 2026-06-03 → 2026-06-10 = 7 days
        expect(msg.text).toContain('7 days');
    });

    it('is fail-open: a mailer error returns { sent: false } and does not throw', async () => {
        sendEmailMock.mockRejectedValue(new Error('SMTP down'));
        await expect(sendInviteEmail(baseParams)).resolves.toEqual({
            sent: false,
        });
    });

    it('handles a missing inviter name gracefully', async () => {
        sendEmailMock.mockResolvedValue(undefined);
        await sendInviteEmail({ ...baseParams, invitedByName: null });
        const msg = sendEmailMock.mock.calls[0][0];
        expect(msg.text).toContain("You've been invited");
    });

    it('reports NOT sent on the console sink in production (no SMTP configured)', async () => {
        // The console sink "succeeds" but delivers nothing — in prod that is a
        // misconfiguration, so the result must be { sent: false } so the admin
        // gets the copy-link fallback instead of a false "emailed" toast.
        sendEmailMock.mockResolvedValue(undefined);
        const prev = process.env.NODE_ENV;
        (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
        mockActiveProvider = new MockConsoleEmailProvider();
        try {
            await expect(sendInviteEmail(baseParams)).resolves.toEqual({ sent: false });
        } finally {
            (process.env as Record<string, string | undefined>).NODE_ENV = prev;
        }
    });

    it('reports sent in production when a real (non-console) provider is active', async () => {
        sendEmailMock.mockResolvedValue(undefined);
        const prev = process.env.NODE_ENV;
        (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
        mockActiveProvider = {}; // not a ConsoleEmailProvider instance → real delivery
        try {
            await expect(sendInviteEmail(baseParams)).resolves.toEqual({ sent: true });
        } finally {
            (process.env as Record<string, string | undefined>).NODE_ENV = prev;
        }
    });
});
